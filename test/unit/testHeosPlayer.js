// @ts-nocheck
import sinon from 'sinon';
// The query string keeps the harness resolve hook, which swaps every '/lib/heos-player.js'
// import for the fake, from applying here: this file tests the real module.
import HeosPlayer from '../../lib/heos-player.js?real';

describe('HeosPlayer connect after disconnect', () => {
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    /**
     * A player on a minimal adapter stub whose UPnP init waits until released.
     */
    function stoppablePlayer() {
        const heos = {
            config: { autoPlay: false },
            logInfo: () => {},
            logDebug: () => {},
            queueMsg: sinon.spy(),
            setStateAsync: sinon.spy(async () => {}),
            getStates: () => {},
            // adapter timer API (the player uses it since upstream 3.3.0)
            setTimeout: (cb, ms) => setTimeout(cb, ms),
            setInterval: (cb, ms) => setInterval(cb, ms),
            clearTimeout: timer => clearTimeout(timer),
            clearInterval: timer => clearInterval(timer),
        };
        const player = new HeosPlayer(heos, { pid: 1, name: 'Player 1', ip: '10.0.0.2' });
        player.pid = 1;
        player.name = 'Player 1';
        player.ip = '10.0.0.2';
        let release;
        player.upnp = { init: () => new Promise(resolve => (release = resolve)) };
        return { heos, player, release: () => release() };
    }

    it('sends the start commands and marks itself connected after 5 s', async () => {
        const { heos, player, release } = stoppablePlayer();
        const connecting = player.connect();
        release();
        await connecting;
        // play state, play mode, now playing, volume, firmware update check, Quick Select
        heos.queueMsg.should.have.callCount(6);
        await clock.tickAsync(5000);
        player.connected.should.be.true;
        heos.setStateAsync.should.have.been.calledWith('players.1.connected', true, true);
    });

    it('neither sends commands nor marks itself connected when stopped while connecting', async () => {
        const { heos, player, release } = stoppablePlayer();
        const connecting = player.connect();
        await player.disconnect();
        release();
        await connecting;
        await clock.tickAsync(5000);
        heos.queueMsg.should.not.have.been.called;
        player.connected.should.be.false;
        heos.setStateAsync.should.not.have.been.calledWith('players.1.connected', true, true);
        (player.connect_timeout === undefined).should.be.true;
    });
});

describe('HeosPlayer timers', () => {
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    it('does not pile up registered timers when the response timer is replaced', () => {
        // like js-controller: a timer leaves the set only when it fires or is cleared through the adapter
        const timers = new Set();
        const heos = {
            config: { autoPlay: false },
            logInfo: () => {},
            logDebug: () => {},
            getUptime: () => 10,
            setTimeout: (cb, ms) => {
                const timer = setTimeout(() => {
                    timers.delete(timer);
                    cb();
                }, ms);
                timers.add(timer);
                return timer;
            },
            clearTimeout: timer => {
                clearTimeout(timer);
                timers.delete(timer);
            },
        };
        const player = new HeosPlayer(heos, { pid: 1, name: 'Player 1', ip: '10.0.0.2' });
        player.state_simple = true;
        for (let i = 0; i < 100; i++) {
            player.detectHeosResponseTimeout();
        }
        timers.size.should.equal(1);
    });
});
