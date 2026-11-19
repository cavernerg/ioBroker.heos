// @ts-nocheck
import sinon from 'sinon';
import { connected, createHeos } from './harness.js';
import { FakeSocket } from './fakes/net.js';
import { STATES } from '../../lib/constants.js';

// Captured before any test installs sinon fake timers.
const realSetImmediate = setImmediate;

describe('fake socket', () => {
    afterEach(() => {
        sinon.restore();
        FakeSocket.reset();
    });

    it('lets connect() run without opening a real connection', async () => {
        const heos = await createHeos();
        heos.connect('10.0.0.1');
        FakeSocket.instances.should.have.length(1);
        FakeSocket.instances[0].host.should.equal('10.0.0.1');
        FakeSocket.instances[0].port.should.equal(1255);
        heos.state.should.equal(STATES.Connecting);
        heos.net_client.should.equal(FakeSocket.instances[0]);
    });
});

describe('reconnect lock', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
        FakeSocket.reset();
    });

    it('schedules exactly one search when reconnect is requested twice during a disconnect', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        // Request the second reconnect in the window the production log showed:
        // disconnect() has already reset the state to Disconnected but has not
        // returned yet, so reconnect() has not set Reconnecting.
        const resetVars = heos.resetVars.bind(heos);
        let second;
        sinon.stub(heos, 'resetVars').callsFake(initMode => {
            resetVars(initMode);
            second ??= heos.reconnect();
        });
        const first = heos.reconnect();
        await Promise.all([first, second]);
        await heos.reconnect(); // third request after disconnect() finished, before the timer fired
        await clock.tickAsync(5000);
        heos.search.should.have.been.calledOnce;
    });

    it('accepts a new reconnect after the scheduled search has started', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        const search = sinon.stub(heos, 'search').callsFake(function () {
            heos.reconnect_pending = false;
            heos.state = STATES.Searching;
        });
        await heos.reconnect();
        await clock.tickAsync(5000);
        await heos.reconnect();
        await clock.tickAsync(5000);
        search.should.have.been.calledTwice;
    });

    it('does not leave the lock set after an explicit system/disconnect', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        await heos.reconnect();
        await heos.executeCommand('system/disconnect');
        heos.reconnect_pending.should.equal(false);
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
        await heos.reconnect();
        await clock.tickAsync(5000);
        heos.search.should.have.been.calledOnce;
    });

    it('waits for disconnect before searching on system/connect', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        const order = [];
        sinon.stub(heos, 'disconnect').callsFake(async () => {
            await Promise.resolve();
            order.push('disconnected');
        });
        sinon.stub(heos, 'search').callsFake(() => order.push('search'));
        await heos.executeCommand('system/connect');
        order.should.deep.equal(['disconnected', 'search']);
    });

    /**
     * Let the first disconnect() run to its end but not return until released,
     * so a reconnect() that called it is still waiting inside it.
     *
     * @param {object} heos adapter instance
     * @returns {() => void} releases the held disconnect()
     */
    function holdFirstDisconnect(heos) {
        const realDisconnect = heos.disconnect.bind(heos);
        let release;
        const gate = new Promise(resolve => (release = resolve));
        let first = true;
        sinon.stub(heos, 'disconnect').callsFake(async () => {
            const held = first;
            first = false;
            await realDisconnect();
            if (held) {
                await gate;
            }
        });
        return release;
    }

    it('drops a running reconnect on system/disconnect and accepts a later one', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        const release = holdFirstDisconnect(heos);
        const running = heos.reconnect();
        await clock.tickAsync(0);
        await heos.executeCommand('system/disconnect');
        release();
        await running;
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
        heos.reconnect_pending.should.equal(false);
        await heos.reconnect();
        await clock.tickAsync(5000);
        heos.search.should.have.been.calledOnce;
    });

    it('searches exactly once on system/connect during a running reconnect', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        const release = holdFirstDisconnect(heos);
        const running = heos.reconnect();
        await clock.tickAsync(0);
        await heos.executeCommand('system/connect');
        release();
        await running;
        await clock.tickAsync(10000);
        heos.search.should.have.been.calledOnce;
    });

    it('schedules no search after unload when a reconnect is still disconnecting', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        const release = holdFirstDisconnect(heos);
        const running = heos.reconnect();
        await clock.tickAsync(0);
        await heos.onUnload();
        release();
        await running;
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
    });
});

describe('timers and sockets across reconnects', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
        FakeSocket.reset();
    });

    it('does not fire a reconnect timer that resetVars dropped', async () => {
        const heos = await createHeos();
        heos.search = sinon.stub();
        heos.reconnect_timeout = heos.setTimeout(() => heos.search(), 5000);
        heos.resetVars(false);
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
    });

    it('does not fire a heartbeat interval that resetVars dropped', async () => {
        const heos = await createHeos();
        const tick = sinon.stub();
        heos.heartbeat_interval = heos.setInterval(tick, 1000);
        heos.resetVars(false);
        await clock.tickAsync(5000);
        tick.should.not.have.been.called;
    });

    it('does not fire any timer whose field resetVars resets', async () => {
        const heos = await createHeos();
        const fired = sinon.stub();
        const intervals = ['heartbeat_interval', 'player_refresh_interval', 'ssdp_search_interval'];
        const timeouts = [
            'ssdp_search_timeout',
            'reconnect_timeout',
            'reboot_timeout',
            'replay_timeout',
            'incomplete_players_timeout',
        ];
        for (const name of intervals) {
            heos[name] = heos.setInterval(() => fired(name), 1000);
        }
        for (const name of timeouts) {
            heos[name] = heos.setTimeout(() => fired(name), 1000);
        }
        heos.resetVars(false);
        await clock.tickAsync(5000);
        fired.should.not.have.been.called;
    });

    it('closes the previous socket when connecting again', async () => {
        const heos = await createHeos();
        heos.connect('10.0.0.1');
        heos.connect('10.0.0.2');
        FakeSocket.instances[0].destroyed.should.equal(true);
        heos.net_client.should.equal(FakeSocket.instances[1]);
    });

    for (const event of ['error', 'timeout', 'end']) {
        it(`ignores a late ${event} event of a replaced socket`, async () => {
            const heos = await createHeos();
            heos.reconnect = sinon.stub();
            heos.raiseLeaderFailures = sinon.stub();
            heos.connect('10.0.0.1');
            heos.connect('10.0.0.2');
            FakeSocket.instances[0].emit(event, new Error('late'));
            heos.reconnect.should.not.have.been.called;
            heos.raiseLeaderFailures.should.not.have.been.called;
        });
    }

    it('ignores a late connect event of a replaced socket', async () => {
        const heos = await createHeos();
        heos.startHeartbeat = sinon.stub();
        heos.getPlayers = sinon.stub();
        heos.connect('10.0.0.1');
        heos.connect('10.0.0.2');
        FakeSocket.instances[0].emit('connect');
        await clock.tickAsync(0);
        heos.state.should.equal(STATES.Connecting);
        heos.startHeartbeat.should.not.have.been.called;
        heos.getPlayers.should.not.have.been.called;
    });

    it('ignores late data of a replaced socket', async () => {
        const heos = await createHeos();
        heos.onData = sinon.stub();
        heos.connect('10.0.0.1');
        heos.connect('10.0.0.2');
        FakeSocket.instances[0].emit('data', Buffer.from('{}'));
        heos.onData.should.not.have.been.called;
    });

    it('still reacts to events of the current socket', async () => {
        const heos = await createHeos();
        heos.reconnect = sinon.stub();
        heos.connect('10.0.0.1');
        FakeSocket.instances[0].emit('end');
        heos.reconnect.should.have.been.calledOnce;
    });
});

describe('reconnect lock when disconnect fails', () => {
    let clock;
    let unhandled;
    const onUnhandled = reason => unhandled.push(reason);

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        unhandled = [];
        process.prependListener('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
        process.removeListener('unhandledRejection', onUnhandled);
        clock.restore();
        sinon.restore();
        FakeSocket.reset();
    });

    /**
     * Let pending promise rejections be reported (outside the fake clock).
     *
     * @returns {Promise<void>} resolves after the next real macrotask
     */
    function settle() {
        return new Promise(resolve => realSetImmediate(resolve));
    }

    /**
     * Connected adapter whose disconnect() rejects.
     *
     * @returns {Promise<object>} the Heos adapter instance
     */
    async function failingDisconnect() {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        heos.idToDCS = () => ({ device: 'command' });
        sinon.stub(heos, 'disconnect').rejects(new Error('disconnect failed'));
        return heos;
    }

    it('still searches once after reconnect() and accepts a later reconnect', async () => {
        const heos = await failingDisconnect();
        heos.search.callsFake(() => {
            heos.reconnect_pending = false;
            heos.state = STATES.Searching;
        });
        await heos.reconnect();
        await settle();
        unhandled.should.deep.equal([]);
        heos.logs.should.deep.include({ level: 'warn', msg: '[reconnect] Error: disconnect failed' });
        await clock.tickAsync(4999);
        heos.search.should.not.have.been.called;
        await clock.tickAsync(1);
        heos.search.should.have.been.calledOnce;
        heos.reconnect_pending.should.equal(false);

        await heos.reconnect();
        await clock.tickAsync(5000);
        heos.search.should.have.been.calledTwice;
    });

    it('does not keep the lock when scheduling the search fails', async () => {
        const heos = await failingDisconnect();
        sinon.stub(heos, 'setTimeout').throws(new Error('no timer'));
        await heos.reconnect();
        await settle();
        unhandled.should.deep.equal([]);
        heos.reconnect_pending.should.equal(false);
        heos.logs.should.deep.include({ level: 'warn', msg: '[reconnect] Error: no timer' });
    });

    for (const command of ['system/connect', 'system/disconnect']) {
        it(`releases the lock after ${command}`, async () => {
            const heos = await failingDisconnect();
            heos.onStateChange('heos.0.command', { val: command, ack: false });
            await settle();
            heos.reconnect_pending.should.equal(false);
            unhandled.should.deep.equal([]);
            heos.logs.should.deep.include({
                level: 'debug',
                msg: '[executeCommand] Error: disconnect failed',
            });
            heos.search.should.not.have.been.called;
        });
    }
});
