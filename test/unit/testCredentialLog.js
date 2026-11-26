// @ts-nocheck
import sinon from 'sinon';
import { createHeos } from './harness.js';
import { FakeSocket } from './fakes/net.js';
import { STATES } from '../../lib/constants.js';

const USERNAME = 'user@example.org';
const PASSWORD = 'secret-pw';
const SERVICE_USERNAME = 'tidal-user@music.example';

describe('credentials in log lines', () => {
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
     * Adapter with credentials, connected to a fake socket whose data handler is the real one.
     *
     * @returns {Promise<object>} the Heos adapter instance
     */
    async function signedInConnection() {
        const heos = await createHeos({ username: USERNAME, password: PASSWORD });
        heos.reconnect = sinon.stub();
        heos.raiseLeaderFailures = sinon.stub();
        heos.connect('10.0.0.1');
        heos.state = STATES.Connected;
        return heos;
    }

    /**
     * Feed raw data from the device to the current connection and let it be parsed.
     *
     * @param {object} heos adapter instance
     * @param {string} data raw data as the device sends it
     */
    async function receiveRaw(heos, data) {
        heos.net_client.emit('data', Buffer.from(data));
        await clock.tickAsync(0);
    }

    /**
     * Feed one HEOS answer to the current connection and let it be parsed.
     *
     * @param {object} heos adapter instance
     * @param {object} answer parsed HEOS answer
     */
    async function receive(heos, answer) {
        await receiveRaw(heos, `${JSON.stringify(answer)}\r\n`);
    }

    /**
     * Log lines above silly level that contain the account name or the password.
     *
     * @param {object} heos adapter instance
     * @returns {object[]} the leaking log entries
     */
    function leaks(heos) {
        return heos.logs.filter(
            entry => entry.level !== 'silly' && (entry.msg.includes(PASSWORD) || entry.msg.includes(USERNAME)),
        );
    }

    /**
     * The sign-in command as written to the socket.
     *
     * @returns {string} the command
     */
    function signInWrite() {
        return `heos://system/sign_in?un=${USERNAME}&pw=${PASSWORD}\n`;
    }

    it('still sends the credentials to the device', async () => {
        const heos = await signedInConnection();
        heos.signIn();
        heos.net_client.written.should.deep.equal([signInWrite()]);
    });

    it('keeps them out of sending, duplicate and timeout lines', async () => {
        const heos = await signedInConnection();
        heos.signIn();
        heos.signIn();
        heos.logs.some(entry => entry.msg.startsWith('Skip duplicate request')).should.equal(true);

        await clock.tickAsync(11000);
        heos.signIn();
        heos.logs.some(entry => entry.level === 'warn' && entry.msg.includes('Response timed out')).should.equal(true);
        heos.net_client.written.should.deep.equal([signInWrite(), signInWrite()]);

        leaks(heos).should.deep.equal([]);
    });

    it('keeps them out of the lines for the answers to the sign-in', async () => {
        const heos = await signedInConnection();
        heos.signIn();
        await receive(heos, {
            heos: {
                command: 'system/sign_in',
                result: 'success',
                message: `command under process&un=${USERNAME}&pw=${PASSWORD}`,
            },
        });
        await receive(heos, {
            heos: { command: 'system/sign_in', result: 'success', message: `signed_in=&un=${USERNAME}` },
        });
        heos.logs.some(entry => entry.msg.startsWith('parseResponse: Reset command timeout')).should.equal(true);
        heos.logs.some(entry => entry.msg.startsWith('deleteRequestTime: before')).should.equal(true);
        heos.request_time.should.deep.equal({});

        leaks(heos).should.deep.equal([]);
    });

    it('keeps them out of the lines for a failed sign-in and its replay', async () => {
        const heos = await signedInConnection();
        heos.signIn();
        await receive(heos, {
            heos: {
                command: 'system/sign_in',
                result: 'fail',
                message: `eid=13&text=Processing previous command&un=${USERNAME}&pw=${PASSWORD}`,
            },
        });
        await clock.tickAsync(2000);
        heos.logs.some(entry => entry.msg.startsWith('parseResponse: Replay command')).should.equal(true);
        heos.net_client.written.should.deep.equal([signInWrite(), signInWrite()]);

        leaks(heos).should.deep.equal([]);
    });

    it('keeps the account name out of the lines for a user change', async () => {
        const heos = await signedInConnection();
        await receive(heos, { heos: { command: 'event/user_changed', message: `signed_in&un=${USERNAME}` } });
        heos.logs.some(entry => entry.msg.startsWith('sign: ')).should.equal(true);

        leaks(heos).should.deep.equal([]);
    });

    it('keeps the account name out of the error line of a failing answer', async () => {
        const heos = await signedInConnection();
        heos.setStateAsync = sinon.stub().rejects(new Error('database gone'));
        await receive(heos, { heos: { command: 'event/user_changed', message: `signed_in&un=${USERNAME}` } });
        heos.logs.some(entry => entry.level === 'error' && entry.msg.startsWith('[parseResponse]')).should.equal(true);

        leaks(heos).should.deep.equal([]);
    });

    it('keeps them out of the lines for an answer split across two packets', async () => {
        const heos = await signedInConnection();
        heos.signIn();
        const answer = JSON.stringify({
            heos: { command: 'system/sign_in', result: 'success', message: `signed_in=&un=${USERNAME}` },
        });
        const cut = answer.indexOf('&un=') + 2;
        await receiveRaw(heos, answer.slice(0, cut));
        await receiveRaw(heos, `${answer.slice(cut)}\r\n`);
        heos.request_time.should.deep.equal({});

        leaks(heos).should.deep.equal([]);
    });

    /**
     * The answer to browse/get_music_sources with one service the user is signed in to,
     * spaced the way the device sends it.
     *
     * @returns {string} raw answer without line end
     */
    function musicSourcesAnswer() {
        return JSON.stringify({
            heos: { command: 'browse/get_music_sources', result: 'success', message: '' },
            payload: [
                { name: 'TuneIn', image_url: '', type: 'music_service', sid: 3, available: 'true' },
                {
                    name: 'Tidal',
                    image_url: '',
                    type: 'music_service',
                    sid: 10,
                    available: 'true',
                    service_username: SERVICE_USERNAME,
                },
            ],
        }).replace(/":/g, '": ');
    }

    /**
     * Log lines above silly level that contain the account name of a music service or a part of it.
     *
     * @param {object} heos adapter instance
     * @returns {object[]} the leaking log entries
     */
    function serviceLeaks(heos) {
        return heos.logs.filter(
            entry => entry.level !== 'silly' && (entry.msg.includes('tidal-us') || entry.msg.includes('music.example')),
        );
    }

    it('keeps the account name of a music service out of the lines for the music sources', async () => {
        const heos = await signedInConnection();
        const parseResponse = sinon.spy(heos, 'parseResponse');
        await receiveRaw(heos, `${musicSourcesAnswer()}\r\n`);
        parseResponse.calledOnce.should.equal(true);
        parseResponse.firstCall.args[0].should.include(SERVICE_USERNAME);
        heos.logs.some(entry => entry.msg.includes('"service_username": "***"')).should.equal(true);

        serviceLeaks(heos).should.deep.equal([]);
    });

    it('keeps it out when the packet boundary cuts the account name of the music service', async () => {
        const heos = await signedInConnection();
        const parseResponse = sinon.spy(heos, 'parseResponse');
        const answer = musicSourcesAnswer();
        const cut = answer.indexOf(SERVICE_USERNAME) + 8;
        await receiveRaw(heos, answer.slice(0, cut));
        await receiveRaw(heos, `${answer.slice(cut)}\r\n`);
        parseResponse.calledOnce.should.equal(true);
        parseResponse.firstCall.args[0].should.include(SERVICE_USERNAME);

        serviceLeaks(heos).should.deep.equal([]);
    });

    it('keeps it out when the packet boundary cuts the field name before it', async () => {
        const heos = await signedInConnection();
        const answer = musicSourcesAnswer();
        const cut = answer.indexOf('"service_username"') + 9;
        await receiveRaw(heos, answer.slice(0, cut));
        await receiveRaw(heos, `${answer.slice(cut)}\r\n`);
        heos.logs.some(entry => entry.msg.startsWith('onData: invalid json')).should.equal(true);

        serviceLeaks(heos).should.deep.equal([]);
    });

    it('keeps the HEOS account name out when the packet boundary cuts it', async () => {
        const heos = await signedInConnection();
        const answer = JSON.stringify({ heos: { command: 'event/user_changed', message: `signed_in&un=${USERNAME}` } });
        const cut = answer.indexOf(USERNAME) + 4;
        await receiveRaw(heos, answer.slice(0, cut));
        await receiveRaw(heos, `${answer.slice(cut)}\r\n`);

        heos.logs
            .filter(entry => entry.level !== 'silly' && entry.msg.includes('example.org'))
            .should.deep.equal([]);
    });
});
