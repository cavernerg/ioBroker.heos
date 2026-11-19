// @ts-nocheck
import sinon from 'sinon';
import { createHeos, entry } from './harness.js';
import { FakeSocket } from './fakes/net.js';
import FakeHeosPlayer from './fakes/heos-player.js';

const CREDENTIALS = { username: 'user', password: 'secret' };

/**
 * Feed one HEOS answer to the current connection and let it be parsed.
 *
 * @param {object} heos adapter instance
 * @param {object} answer parsed HEOS answer
 * @param {object} clock sinon fake clock
 */
async function receive(heos, answer, clock) {
    heos.net_client.emit('data', Buffer.from(`${JSON.stringify(answer)}\r\n`));
    await clock.tickAsync(0);
}

/**
 * Data written to a socket that carries a sign-in.
 *
 * @param {FakeSocket} socket fake socket
 * @returns {string[]} the sign-in writes
 */
function signIns(socket) {
    return socket.written.filter(data => data.includes('sign_in'));
}

describe('connection opened only to reboot a device', () => {
    let clock;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        FakeHeosPlayer.reset();
    });

    afterEach(() => {
        clock.restore();
        sinon.restore();
        FakeSocket.reset();
    });

    /**
     * Adapter with credentials whose current connection was opened to reboot a device.
     *
     * @returns {Promise<object>} the Heos adapter instance
     */
    async function rebootConnection() {
        const heos = await createHeos(CREDENTIALS);
        heos.reconnect = sinon.stub();
        heos.reboot_ips = ['10.0.0.5'];
        heos.connect('10.0.0.5');
        heos.net_client.emit('connect');
        await clock.tickAsync(0);
        heos.net_client.written.should.deep.include('heos://system/reboot\n');
        return heos;
    }

    it('does not sign in after an eid=8 answer', async () => {
        const heos = await rebootConnection();
        await receive(
            heos,
            { heos: { command: 'player/get_players', result: 'fail', message: 'eid=8&text=User not logged in' } },
            clock,
        );
        signIns(heos.net_client).should.deep.equal([]);
    });

    it('does not sign in after a user_changed event', async () => {
        const heos = await rebootConnection();
        await receive(heos, { heos: { command: 'event/user_changed', message: 'signed_out' } }, clock);
        signIns(heos.net_client).should.deep.equal([]);
    });

    it('does not sign in after a get_players answer', async () => {
        const heos = await rebootConnection();
        await receive(
            heos,
            {
                heos: { command: 'player/get_players', result: 'success', message: '' },
                payload: [entry(1, '10.0.0.2')],
            },
            clock,
        );
        FakeHeosPlayer.instances.should.have.length(1);
        signIns(heos.net_client).should.deep.equal([]);
    });

    it('signs in again on a following normal connection', async () => {
        const heos = await rebootConnection();
        heos.connect('10.0.0.6');
        heos.net_client.emit('connect');
        await clock.tickAsync(0);
        await receive(heos, { heos: { command: 'event/user_changed', message: 'signed_out' } }, clock);
        signIns(heos.net_client).should.have.length(1);
    });

    it('signs in again on a normal connection after a disconnect', async () => {
        const heos = await rebootConnection();
        await heos.disconnect();
        heos.connect('10.0.0.6');
        heos.net_client.emit('connect');
        await clock.tickAsync(0);
        await receive(heos, { heos: { command: 'event/user_changed', message: 'signed_out' } }, clock);
        signIns(heos.net_client).should.have.length(1);
    });
});
