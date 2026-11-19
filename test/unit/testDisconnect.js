// @ts-nocheck
import sinon from 'sinon';
import { connected } from './harness.js';
import { FakeSocket } from './fakes/net.js';
import { STATES } from '../../lib/constants.js';

describe('disconnect teardown', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
        FakeSocket.reset();
    });

    /**
     * Connected adapter with a fake socket and an SSDP client.
     *
     * @returns {Promise<object>} the Heos adapter instance
     */
    async function withConnection() {
        const heos = await connected();
        heos.net_client = new FakeSocket('10.0.0.1', 1255);
        heos.nodessdp_client = { stop: sinon.stub() };
        return heos;
    }

    it('finishes the teardown when a state write fails', async () => {
        const heos = await withConnection();
        const socket = heos.net_client;
        const ssdp = heos.nodessdp_client;
        sinon.stub(heos, 'setStateAsync').onFirstCall().rejects(new Error('write failed')).resolves();
        const setStateChangedAsync = sinon.spy(heos, 'setStateChangedAsync');
        await heos.disconnect();
        socket.destroyed.should.equal(true);
        ssdp.stop.should.have.been.calledOnce;
        (heos.net_client === undefined).should.be.true;
        (heos.nodessdp_client === undefined).should.be.true;
        heos.state.should.equal(STATES.Disconnected);
        setStateChangedAsync.should.have.been.calledWith('info.connection', false, true);
        setStateChangedAsync.should.have.been.calledWith('connected_ip', '', true);
        heos.logs.filter(log => log.level === 'warn').should.have.length(1);
    });

    it('finishes the teardown when stopping the players fails', async () => {
        const heos = await withConnection();
        const socket = heos.net_client;
        sinon.stub(heos, 'stopPlayers').rejects(new Error('stop failed'));
        await heos.disconnect();
        socket.destroyed.should.equal(true);
        (heos.net_client === undefined).should.be.true;
        heos.state.should.equal(STATES.Disconnected);
    });

    it('lets a later reconnect run after a failed teardown step', async () => {
        const heos = await connected({ reconnectTimeout: 5000 }, { realReconnect: true });
        heos.search = sinon.stub();
        sinon.stub(heos, 'setStateAsync').onFirstCall().rejects(new Error('write failed')).resolves();
        await heos.disconnect();
        await heos.reconnect();
        await clock.tickAsync(5000);
        heos.search.should.have.been.calledOnce;
    });

    it('waits for the per-player connected writes', async () => {
        const heos = await withConnection();
        sinon.stub(heos, 'getChannelsAsync').resolves([{ _id: 'heos.0.players.1' }, { _id: 'heos.0.players.2' }]);
        const written = [];
        sinon.stub(heos, 'setStateAsync').callsFake(async id => {
            if (id.endsWith('.connected')) {
                await new Promise(resolve => setTimeout(resolve, 100));
                written.push(id);
            }
        });
        let resolved = false;
        const running = heos.disconnect().then(() => (resolved = true));
        await clock.tickAsync(50);
        resolved.should.equal(false);
        await clock.tickAsync(100);
        await running;
        written.sort().should.deep.equal(['heos.0.players.1.connected', 'heos.0.players.2.connected']);
    });

    it('finishes the teardown when one per-player write fails', async () => {
        const heos = await withConnection();
        sinon.stub(heos, 'getChannelsAsync').resolves([{ _id: 'heos.0.players.1' }, { _id: 'heos.0.players.2' }]);
        sinon.stub(heos, 'setStateAsync').callsFake(async id => {
            if (id === 'heos.0.players.1.connected') {
                throw new Error('write failed');
            }
        });
        await heos.disconnect();
        heos.state.should.equal(STATES.Disconnected);
        heos.setStateAsync.should.have.been.calledWith('heos.0.players.2.connected', false, true);
    });
});
