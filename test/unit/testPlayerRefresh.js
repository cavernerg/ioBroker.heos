// @ts-nocheck
import sinon from 'sinon';
import { connected } from './harness.js';
import FakeHeosPlayer from './fakes/heos-player.js';

describe('player list refresh', () => {
    let clock;
    beforeEach(() => {
        FakeHeosPlayer.reset();
        clock = sinon.useFakeTimers();
    });
    afterEach(() => clock.restore());

    it('asks for the player list every searchInterval while connected without SSDP discovery', async () => {
        const heos = await connected({ searchInterval: '30000' });
        heos.startPlayerRefresh();
        await clock.tickAsync(90000);
        heos.getPlayers.should.have.been.calledThrice;
    });

    it('does not run twice when started twice, and stops when asked', async () => {
        const heos = await connected({ searchInterval: 30000 });
        heos.startPlayerRefresh();
        heos.startPlayerRefresh();
        await clock.tickAsync(30000);
        heos.getPlayers.should.have.been.calledOnce;
        heos.stopPlayerRefresh();
        await clock.tickAsync(60000);
        heos.getPlayers.should.have.been.calledOnce;
    });

    for (const bad of [0, '', 'abc', -5]) {
        it(`does not start for searchInterval ${JSON.stringify(bad)}`, async () => {
            const heos = await connected({ searchInterval: bad });
            heos.startPlayerRefresh();
            await clock.tickAsync(120000);
            heos.getPlayers.should.not.have.been.called;
        });
    }

    it('does not start while the SSDP search interval runs', async () => {
        const heos = await connected({ searchInterval: 30000 });
        heos.ssdp_search_interval = {}; // the SSDP search interval asks for the player list itself
        heos.startPlayerRefresh();
        (heos.player_refresh_interval === undefined).should.be.true;
        await clock.tickAsync(90000);
        heos.getPlayers.should.not.have.been.called;
    });

    it('is stopped by disconnect', async () => {
        const heos = await connected({ searchInterval: 30000 });
        heos.startPlayerRefresh();
        await heos.disconnect();
        await clock.tickAsync(60000);
        heos.getPlayers.should.not.have.been.called;
    });
});
