// @ts-nocheck
import sinon from 'sinon';
import { connected, entry } from './harness.js';
import FakeHeosPlayer from './fakes/heos-player.js';
import { PLAYER_CONNECT_TIMEOUT_MS, STATES } from '../../lib/constants.js';

describe('player connect deadline', () => {
    let clock;
    beforeEach(() => {
        FakeHeosPlayer.reset();
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    it('is 45 s', () => {
        PLAYER_CONNECT_TIMEOUT_MS.should.equal(45000);
    });

    it('skips a player whose connect never settles and keeps processing later answers', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = player => (player.pid === 1 ? new Promise(() => {}) : Promise.resolve());
        let finished = false;
        const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]).then(() => (finished = true));
        await clock.tickAsync(PLAYER_CONNECT_TIMEOUT_MS - 1);
        finished.should.be.false;
        await clock.tickAsync(1);
        await pass;
        heos.start_players_running.should.be.false;
        Object.keys(heos.players).should.deep.equal(['2']);
        FakeHeosPlayer.instances[0].calls.disconnect.should.equal(1);
        heos.raiseFailures.should.have.been.calledOnceWith('10.0.0.2');
        heos.logs.filter(l => l.level === 'warn' && l.msg.includes("can't connect player")).should.have.length(1);

        await heos.startPlayers([entry(2, '10.0.0.3'), entry(3, '10.0.0.4')]);
        Object.keys(heos.players).sort().should.deep.equal(['2', '3']);
        heos.getGroups.should.have.been.calledTwice;
    });

    it('leaves no pending timer when the connect settles before the deadline', async () => {
        const heos = await connected();
        const before = clock.countTimers();
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        Object.keys(heos.players).should.deep.equal(['1']);
        clock.countTimers().should.equal(before);
    });

    it('leaves no pending timer when the connect fails before the deadline', async () => {
        const heos = await connected();
        FakeHeosPlayer.connectImpl = async () => {
            throw new Error('refused');
        };
        const before = clock.countTimers();
        await heos.startPlayers([entry(1, '10.0.0.2')]);
        clock.countTimers().should.equal(before);
    });

    it('ignores a connect that rejects after the deadline passed', async () => {
        const heos = await connected();
        const onUnhandled = sinon.spy();
        process.on('unhandledRejection', onUnhandled);
        try {
            FakeHeosPlayer.connectImpl = () =>
                new Promise((resolve, reject) =>
                    setTimeout(() => reject(new Error('late')), PLAYER_CONNECT_TIMEOUT_MS + 5000),
                );
            const pass = heos.startPlayers([entry(1, '10.0.0.2'), entry(2, '10.0.0.3')]);
            await clock.tickAsync(2 * PLAYER_CONNECT_TIMEOUT_MS + 10000);
            await pass;
            await clock.tickAsync(10000);
            onUnhandled.should.not.have.been.called;
            heos.raiseFailures.should.have.been.calledTwice;
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });
});

describe('repeated player connect failures', () => {
    let failing;
    beforeEach(() => {
        FakeHeosPlayer.reset();
        failing = true;
        FakeHeosPlayer.connectImpl = async player => {
            if (player.pid === 1 && failing) {
                throw new Error('refused');
            }
        };
    });

    const warnings = heos => heos.logs.filter(l => l.level === 'warn' && l.msg.includes("can't connect player"));
    const debugSkips = heos => heos.logs.filter(l => l.level === 'debug' && l.msg.includes("can't connect player"));
    const payload = [entry(1, '10.0.0.2'), entry(2, '10.0.0.3')];

    it('warns and counts only once while the connect keeps failing', async () => {
        const heos = await connected();
        await heos.startPlayers(payload);
        await heos.startPlayers(payload);
        await heos.startPlayers(payload);
        FakeHeosPlayer.instances.filter(p => p.pid === 1).should.have.length(3);
        warnings(heos).should.have.length(1);
        debugSkips(heos).should.have.length(2);
        heos.raiseFailures.should.have.been.calledOnceWith('10.0.0.2');
    });

    it('warns and counts again after a successful connect', async () => {
        const heos = await connected();
        await heos.startPlayers(payload);
        await heos.startPlayers(payload);
        failing = false;
        await heos.startPlayers(payload);
        Object.keys(heos.players).sort().should.deep.equal(['1', '2']);
        await heos.stopPlayer('1'); // the player is gone, but still listed by HEOS
        failing = true;
        await heos.startPlayers(payload);
        warnings(heos).should.have.length(2);
        heos.raiseFailures.should.have.been.calledTwice;
    });

    it('forgets the failure streak when the player leaves the list', async () => {
        const heos = await connected();
        await heos.startPlayers(payload);
        await heos.startPlayers([entry(2, '10.0.0.3')]);
        await heos.startPlayers(payload);
        warnings(heos).should.have.length(2);
        heos.raiseFailures.should.have.been.calledTwice;
    });

    it('forgets the failure streak on disconnect', async () => {
        const heos = await connected();
        await heos.startPlayers(payload);
        await heos.disconnect();
        heos.state = STATES.Connected;
        await heos.startPlayers(payload);
        warnings(heos).should.have.length(2);
        heos.raiseFailures.should.have.been.calledTwice;
    });

    it('treats a connect that runs into the deadline like any other failure', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const heos = await connected();
            FakeHeosPlayer.connectImpl = player => (player.pid === 1 ? new Promise(() => {}) : Promise.resolve());
            for (let i = 0; i < 3; i++) {
                const pass = heos.startPlayers(payload);
                await clock.tickAsync(PLAYER_CONNECT_TIMEOUT_MS);
                await pass;
            }
            warnings(heos).should.have.length(1);
            heos.raiseFailures.should.have.been.calledOnce;
        } finally {
            clock.restore();
        }
    });
});
