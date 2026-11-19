// @ts-nocheck
import sinon from 'sinon';
import { connected, entry } from './harness.js';
import FakeHeosPlayer from './fakes/heos-player.js';
import { PLAYER_CONNECT_STAGGER_MS, STATES } from '../../lib/constants.js';

describe('startPlayers and connection changes', () => {
    beforeEach(() => FakeHeosPlayer.reset());

    it('stops after triggering the preferred player reconnect', async () => {
        const heos = await connected({ preferredIPs: '10.0.0.2' });
        heos.preferred_player_ips = ['10.0.0.2'];
        // like the real reconnect(), which starts disconnecting at once
        heos.reconnect.callsFake(() => (heos.state = STATES.Disconnecting));
        await heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        heos.reconnect.should.have.been.calledOnce;
        FakeHeosPlayer.instances.should.have.length(1);
        FakeHeosPlayer.instances[0].calls.connect.should.equal(0);
        heos.getGroups.should.not.have.been.called;
    });

    it('abandons a stale run when the connection changed while a player was connecting', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = async () => {
            heos.players = {}; // what disconnect() + resetVars(false) leave behind
            heos.connection_generation += 1; // a new connect() happened
        };
        await heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        FakeHeosPlayer.instances.should.have.length(1);
        FakeHeosPlayer.instances[0].calls.disconnect.should.equal(1);
        Object.keys(heos.players).should.have.length(0);
        heos.getGroups.should.not.have.been.called;
        heos.reconnect.should.not.have.been.called;
    });

    it('does nothing when the run starts without a connection', async () => {
        const heos = await connected();
        heos.state = STATES.Disconnected;
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        FakeHeosPlayer.instances.should.have.length(0);
        Object.keys(heos.players).should.have.length(0);
        heos.reconnect.should.not.have.been.called;
        heos.raiseLeaderFailures.should.not.have.been.called;
    });

    it('returns quietly when the connection changed while a player was being stopped', async () => {
        const heos = await connected();
        await heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        FakeHeosPlayer.instances[0].disconnect = async () => {
            heos.players = {}; // what disconnect() + resetVars(false) leave behind
            heos.connection_generation += 1; // a new connect() happened
        };
        await heos.startPlayers([entry(2, '10.0.0.3')]);
        heos.reconnect.should.not.have.been.called;
        heos.raiseLeaderFailures.should.not.have.been.called;
        heos.getGroups.should.have.been.calledOnce; // only by the first run
    });
});

describe('startPlayers serialization', () => {
    beforeEach(() => FakeHeosPlayer.reset());

    it('runs one pass at a time and keeps only the newest waiting answer', async () => {
        const heos = await connected();
        let release;
        const gate = new Promise(resolve => (release = resolve));
        FakeHeosPlayer.connectImpl = player => (player.pid === 1 ? gate : Promise.resolve());
        const first = heos.startPlayers([entry(1, '10.0.0.2')]);
        const second = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        const third = heos.startPlayers([entry(1, '10.0.0.2'), entry(3, '10.0.0.4')]);
        release();
        await Promise.all([first, second, third]);
        Object.keys(heos.players).sort().should.deep.equal(['1', '3']);
        FakeHeosPlayer.instances.map(p => p.pid).should.deep.equal([1, 3]);
    });

    it('drops a waiting answer on disconnect', async () => {
        const heos = await connected();
        heos.start_players_running = true; // a pass of the current connection is running
        heos.start_players_generation = heos.connection_generation;
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        heos.start_players_pending.should.have.length(1);
        await heos.disconnect();
        (heos.start_players_pending === undefined).should.be.true;
    });
});

describe('incomplete player entries', () => {
    let clock;
    beforeEach(() => {
        FakeHeosPlayer.reset();
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    it('skips an unknown incomplete entry and asks again after 10 s', async () => {
        const heos = await connected();
        await heos.startPlayers([entry(1, '10.0.0.2'), { pid: 2, ip: '127.0.0.1' }]);
        Object.keys(heos.players).should.deep.equal(['1']);
        heos.reconnect.should.not.have.been.called;
        heos.getPlayers.should.not.have.been.called;
        await clock.tickAsync(10000);
        heos.getPlayers.should.have.been.calledOnce;
    });

    it('keeps a running player whose entry is incomplete', async () => {
        const heos = await connected();
        const first = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        await clock.tickAsync(PLAYER_CONNECT_STAGGER_MS); // the second connect starts staggered
        await first;
        await heos.startPlayers([entry(1, '10.0.0.2'), { pid: 2, name: '' }]);
        Object.keys(heos.players).sort().should.deep.equal(['1', '2']);
        FakeHeosPlayer.instances[1].calls.disconnect.should.equal(0);
        heos.reconnect.should.not.have.been.called;
    });

    it("falls back to today's handling once answers stay incomplete for more than 60 s", async () => {
        const heos = await connected();
        const bad = [entry(1, '10.0.0.2'), { pid: 2, ip: '127.0.0.1' }];
        await heos.startPlayers(bad);
        await clock.tickAsync(61000);
        await heos.startPlayers(bad);
        heos.reconnect.should.have.been.calledOnce;
        heos.raiseLeaderFailures.should.have.been.calledOnce;
        heos.reboot.should.not.have.been.called;
    });

    it('starts a new tolerance window after a complete answer', async () => {
        const heos = await connected();
        const bad = [entry(1, '10.0.0.2'), { pid: 2, ip: '127.0.0.1' }];
        await heos.startPlayers(bad);
        await clock.tickAsync(20000);
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        await clock.tickAsync(50000);
        await heos.startPlayers(bad);
        heos.reconnect.should.not.have.been.called;
    });

    it('does not reboot when every entry is incomplete and rebootOnFailure is on', async () => {
        const heos = await connected({ rebootOnFailure: true });
        await heos.startPlayers([{ pid: 1, ip: '127.0.0.1' }]);
        heos.rebootAll.should.not.have.been.called;
        heos.reboot.should.not.have.been.called;
        heos.reconnect.should.not.have.been.called;
    });

    it('does not conclude a missing SSDP player from an incomplete answer', async () => {
        const heos = await connected();
        heos.ssdp_player_ips = ['10.0.0.3'];
        heos.getUptime = sinon.stub().returns(10);
        await heos.startPlayers([entry(1, '10.0.0.2'), { pid: 2, ip: '127.0.0.1' }]);
        heos.reconnect.should.not.have.been.called;
        heos.raiseFailures.should.not.have.been.called;
        heos.raiseLeaderFailures.should.not.have.been.called;
    });

    it('still reconnects when a complete answer misses an SSDP player', async () => {
        const heos = await connected();
        heos.ssdp_player_ips = ['10.0.0.3'];
        heos.getUptime = sinon.stub().returns(10);
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        heos.reconnect.should.have.been.calledOnce;
    });

    it('handles an empty answer like today, without reboot when rebootOnFailure is off', async () => {
        const heos = await connected({ rebootOnFailure: false });
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        await heos.startPlayers([]);
        Object.keys(heos.players).should.have.length(0);
        heos.rebootAll.should.not.have.been.called;
    });
});

describe('metadata writes for known players', () => {
    beforeEach(() => FakeHeosPlayer.reset());

    it('does not rewrite metadata when the entry is unchanged', async () => {
        const heos = await connected();
        const payload = [entry(1, '10.0.0.2')];
        await heos.startPlayers(payload);
        await heos.startPlayers(payload);
        await heos.startPlayers(payload);
        FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(1);
    });

    it('rewrites metadata once when the firmware version changes', async () => {
        const heos = await connected();
        await heos.startPlayers([entry(1, '10.0.0.2', { version: '3.139.170' })]);
        await heos.startPlayers([entry(1, '10.0.0.2', { version: '3.139.174' })]);
        await heos.startPlayers([entry(1, '10.0.0.2', { version: '3.139.174' })]);
        FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(2);
    });

    it('treats a missing serial like an unchanged entry', async () => {
        const heos = await connected();
        const noSerial = entry(1, '10.0.0.2');
        delete noSerial.serial;
        await heos.startPlayers([noSerial]);
        await heos.startPlayers([{ ...noSerial }]);
        FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(1);
    });

    it('forgets the remembered entry when a player is stopped', async () => {
        const heos = await connected();
        await heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        heos.player_entry_signatures.should.have.all.keys('1', '2');
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        heos.player_entry_signatures.should.have.all.keys('1');
    });

    it('retries a failed metadata rewrite with the next answer', async () => {
        const heos = await connected();
        const onUnhandled = sinon.spy();
        process.on('unhandledRejection', onUnhandled);
        try {
            await heos.startPlayers([entry(1, '10.0.0.2', { version: '3.139.170' })]);
            const before = heos.player_entry_signatures['1'];
            let failures = 1;
            FakeHeosPlayer.initMetaDataImpl = async () => {
                if (failures > 0) {
                    failures -= 1;
                    throw new Error('write failed');
                }
            };
            const changed = [entry(1, '10.0.0.2', { version: '3.139.174' })];
            await heos.startPlayers(changed);
            await new Promise(resolve => setImmediate(resolve));
            onUnhandled.should.not.have.been.called;
            heos.player_entry_signatures['1'].should.equal(before);
            FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(2);

            await heos.startPlayers(changed);
            await new Promise(resolve => setImmediate(resolve));
            FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(3);
            heos.player_entry_signatures['1'].should.equal(heos.getPlayerEntrySignature(changed[0]));

            await heos.startPlayers(changed);
            await new Promise(resolve => setImmediate(resolve));
            FakeHeosPlayer.instances[0].calls.initMetaData.should.equal(3);
            heos.logs.filter(l => l.level === 'debug' && l.msg.includes('write failed')).should.have.length(1);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });
});

describe('staggered player connects', () => {
    let clock;
    beforeEach(() => {
        FakeHeosPlayer.reset();
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    it('does not let a hanging player delay the others', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = player => (player.pid === 1 ? new Promise(() => {}) : Promise.resolve());
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3'), entry(3, '10.0.0.4')]);
        await clock.tickAsync(1000);
        FakeHeosPlayer.instances.map(p => p.calls.connect).should.deep.equal([1, 1, 1]);
        await clock.tickAsync(45000);
        await pass;
        Object.keys(heos.players).sort().should.deep.equal(['2', '3']);
    });

    it('starts the connects 300 ms apart', async () => {
        const heos = await connected();
        const started = [];
        FakeHeosPlayer.connectImpl = async player => {
            started.push([player.pid, Date.now()]);
        };
        const t0 = Date.now();
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3'), entry(3, '10.0.0.4')]);
        await clock.tickAsync(2000);
        await pass;
        started
            .map(([pid, t]) => [pid, t - t0])
            .should.deep.equal([
                [1, 0],
                [2, 300],
                [3, 600],
            ]);
    });

    it('behaves as before when every new player fails to connect', async () => {
        const heos = await connected({ rebootOnFailure: false });
        FakeHeosPlayer.connectImpl = async () => {
            throw new Error('nope');
        };
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        await clock.tickAsync(2000);
        await pass;
        Object.keys(heos.players).should.have.length(0);
        heos.raiseFailures.should.have.been.calledTwice;
        heos.rebootAll.should.not.have.been.called;
        heos.getGroups.should.not.have.been.called;
    });

    it('does not start outstanding connects after the connection changed', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = async player => {
            if (player.pid === 1) {
                heos.players = {};
                heos.connection_generation += 1;
            }
        };
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3'), entry(3, '10.0.0.4')]);
        await clock.tickAsync(2000);
        await pass;
        FakeHeosPlayer.instances.filter(p => p.calls.connect > 0).should.have.length(1);
        heos.getGroups.should.not.have.been.called;
        heos.reconnect.should.not.have.been.called;
    });

    it('skips a delayed connect when the connection changed during the delay', async () => {
        const heos = await connected();
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
        await clock.tickAsync(100);
        heos.players = {}; // what disconnect() + resetVars(false) leave behind
        heos.connection_generation += 1; // a new connect() happened
        await clock.tickAsync(1000);
        await pass;
        FakeHeosPlayer.instances.map(p => p.calls.connect).should.deep.equal([1, 0]);
        FakeHeosPlayer.instances[1].calls.disconnect.should.equal(1);
        heos.getGroups.should.not.have.been.called;
        heos.reconnect.should.not.have.been.called;
    });

    it('waits for running connects before a stale pass returns', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = async player => {
            if (player.pid === 1) {
                return new Promise(() => {});
            }
            heos.players = {};
            heos.connection_generation += 1;
        };
        let finished = false;
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]).then(() => (finished = true));
        await clock.tickAsync(1000);
        finished.should.be.false;
        heos.start_players_running.should.be.true;
        await clock.tickAsync(45000);
        await pass;
        heos.start_players_running.should.be.false;
        FakeHeosPlayer.instances.map(p => p.calls.disconnect).should.deep.equal([1, 1]);
        heos.getGroups.should.not.have.been.called;
        heos.reconnect.should.not.have.been.called;
    });
});

describe('reconnects from startPlayers and after unload', () => {
    let clock;

    beforeEach(() => {
        FakeHeosPlayer.reset();
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
    });

    const native = { reconnectTimeout: 5000, preferredIPs: '10.0.0.9', disableSSDPDiscovery: true };

    it('does not reconnect when a stale pass fails after a manual disconnect', async () => {
        const heos = await connected(native, { realReconnect: true });
        heos.search = sinon.stub();
        let fail;
        FakeHeosPlayer.initMetaDataImpl = () => new Promise((resolve, reject) => (fail = reject));
        const pass = heos.startPlayers([entry(1, '10.0.0.2')]);
        await clock.tickAsync(0);
        await heos.executeCommand('system/disconnect');
        fail(new Error('object write failed'));
        await pass;
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
        heos.raiseLeaderFailures.should.not.have.been.called;
    });

    it('does not schedule a search from reconnect() after unload', async () => {
        const heos = await connected(native, { realReconnect: true });
        heos.search = sinon.stub();
        await heos.onUnload(() => {});
        await heos.reconnect();
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
    });

    it('does not connect from search() after unload', async () => {
        const heos = await connected(native, { realReconnect: true });
        heos.connect = sinon.stub();
        await heos.onUnload(() => {});
        await heos.search();
        await clock.tickAsync(10000);
        heos.connect.should.not.have.been.called;
        heos.state.should.equal(STATES.Disconnected);
    });

    it('connects the preferred player when the reconnect it asked for did not happen', async () => {
        const heos = await connected({ preferredIPs: '10.0.0.2' });
        heos.preferred_player_ips = ['10.0.0.2'];
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        heos.reconnect.should.have.been.calledOnce;
        FakeHeosPlayer.instances.should.have.length(1);
        FakeHeosPlayer.instances[0].calls.connect.should.equal(1);
        heos.getGroups.should.have.been.calledOnce;
    });
});

describe('startPlayers passes of an old connection', () => {
    beforeEach(() => FakeHeosPlayer.reset());

    /**
     * Start a pass that hangs in the metadata write of its first player, then let the
     * adapter look like it opened a new connection.
     *
     * @param {object} heos adapter instance
     * @returns {{ pass: Promise<void>, release: () => void }} the old pass and its release
     */
    function hangOldPass(heos) {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        FakeHeosPlayer.initMetaDataImpl = player => (player.pid === 1 ? gate : Promise.resolve());
        const pass = heos.startPlayers([entry(1, '10.0.0.2')]);
        heos.players = {}; // what disconnect() + resetVars(false) leave behind
        heos.connection_generation += 1; // a new connect() happened
        return { pass, release };
    }

    it('starts the players of a new connection while an old pass hangs', async () => {
        const heos = await connected();
        hangOldPass(heos);
        await heos.startPlayers([entry(2, '10.0.0.3')]);
        Object.keys(heos.players).should.deep.equal(['2']);
        FakeHeosPlayer.instances[1].calls.connect.should.equal(1);
        heos.getGroups.should.have.been.calledOnce;
    });

    it('keeps the new pass serialized when the old pass finally returns', async () => {
        const heos = await connected();
        const old = hangOldPass(heos);
        let releaseNew;
        const newGate = new Promise(resolve => (releaseNew = resolve));
        FakeHeosPlayer.connectImpl = player => (player.pid === 2 ? newGate : Promise.resolve());
        const second = heos.startPlayers([entry(2, '10.0.0.3')]);
        old.release();
        await old.pass;
        heos.start_players_running.should.equal(true);
        const third = heos.startPlayers([entry(2, '10.0.0.3'), entry(3, '10.0.0.4')]);
        heos.start_players_pending.should.have.length(2);
        FakeHeosPlayer.instances.map(p => p.pid).should.deep.equal([1, 2]);
        releaseNew();
        await Promise.all([second, third]);
        Object.keys(heos.players).sort().should.deep.equal(['2', '3']);
        heos.start_players_running.should.equal(false);
    });

    it('drops a waiting answer of the old connection', async () => {
        const heos = await connected();
        let release;
        const gate = new Promise(resolve => (release = resolve));
        FakeHeosPlayer.initMetaDataImpl = player => (player.pid === 1 ? gate : Promise.resolve());
        const pass = heos.startPlayers([entry(1, '10.0.0.2')]);
        await heos.startPlayers([entry(1, '10.0.0.2'), entry(4, '10.0.0.5')]); // waits behind the hanging pass
        heos.players = {};
        heos.connection_generation += 1;
        await heos.startPlayers([entry(2, '10.0.0.3')]);
        release();
        await pass;
        Object.keys(heos.players).should.deep.equal(['2']);
    });
});
