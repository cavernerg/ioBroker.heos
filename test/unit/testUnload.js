// @ts-nocheck
import { readFile } from 'node:fs/promises';
import sinon from 'sinon';
import { connected } from './harness.js';

describe('unload', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
    });

    it('calls the callback after disconnect has finished', async () => {
        const heos = await connected();
        const order = [];
        sinon.stub(heos, 'disconnect').callsFake(async () => {
            await Promise.resolve();
            order.push('disconnected');
        });
        await heos.onUnload(() => order.push('callback'));
        order.should.deep.equal(['disconnected', 'callback']);
    });

    it('calls the callback even when disconnect throws', async () => {
        const heos = await connected();
        sinon.stub(heos, 'disconnect').rejects(new Error('boom'));
        const callback = sinon.stub();
        await heos.onUnload(callback);
        callback.should.have.been.calledOnce;
    });

    it('leaves no reconnect scheduled after unload', async () => {
        const heos = await connected(undefined, { realReconnect: true });
        heos.search = sinon.stub();
        await heos.reconnect();
        await heos.onUnload(() => {});
        await clock.tickAsync(10000);
        heos.search.should.not.have.been.called;
    });

    it('leaves no adapter timer registered after unload', async () => {
        const heos = await connected(undefined, { realReconnect: true });
        heos.search = sinon.stub();
        heos.incomplete_players_timeout = heos.setTimeout(() => {}, 60000);
        heos.player_refresh_interval = heos.setInterval(() => {}, 30000);
        await heos.reconnect();
        heos.timers.size.should.be.above(0);
        await heos.onUnload(() => {});
        heos.timers.size.should.equal(0);
    });

    it('declares a stop timeout in io-package.json', async () => {
        const pkg = JSON.parse(await readFile(new URL('../../io-package.json', import.meta.url), 'utf8'));
        pkg.common.stopTimeout.should.equal(5000);
    });
});
