// @ts-nocheck
import { expect } from 'chai';
import sinon from 'sinon';
import { connected } from './harness.js';

const PRESET_ID = '76dd6744-4656-402a-be28-94ad3f5a4053';
const KEY = PRESET_ID;

describe('group presets', () => {
    afterEach(() => {
        sinon.restore();
    });

    /**
     * Connected adapter with a fake socket and one known preset with the players 1 and -2.
     *
     * @param {any} [leader] value of the preset's leader state (undefined = state does not exist)
     * @returns {Promise<object>} the Heos adapter instance
     */
    async function withPreset(leader) {
        const heos = await connected();
        heos.net_client = { write: sinon.stub() };
        heos.group_preset_ids = { [KEY]: PRESET_ID };
        heos.group_preset_pids = { [KEY]: ['1', '-2'] };
        heos.getStateAsync = sinon.stub().resolves(undefined);
        if (leader !== undefined) {
            heos.getStateAsync.withArgs(`group_presets.${KEY}.leader`).resolves({ val: leader, ack: false });
        }
        return heos;
    }

    /**
     * Feed one HEOS answer to parseResponse.
     *
     * @param {object} heos adapter instance
     * @param {string} command command of the answer
     * @param {string} message message of the answer
     */
    async function answer(heos, command, message) {
        await heos.parseResponse(JSON.stringify({ heos: { command, result: 'success', message } }));
    }

    /**
     * Commands written to the fake socket.
     *
     * @param {object} heos adapter instance
     * @returns {string[]} the written commands
     */
    function written(heos) {
        return heos.net_client.write.getCalls().map(call => call.args[0]);
    }

    describe('apply', () => {
        for (const prefix of ['group', 'group_presets']) {
            it(`clears the request time when the device confirms under ${prefix}/`, async () => {
                const heos = await withPreset();
                await heos.applyGroupPreset(KEY);
                await answer(heos, `${prefix}/apply_group_preset`, `command under process&preset_id=${PRESET_ID}`);
                await answer(heos, `${prefix}/apply_group_preset`, `gid=1164213610&name=&preset_id=${PRESET_ID}`);

                expect(heos.request_time).to.deep.equal({});
            });
        }

        it('sends a second apply of the same preset right away, without a timeout', async () => {
            const heos = await withPreset();
            await heos.applyGroupPreset(KEY);
            await answer(heos, 'group/apply_group_preset', `gid=1164213610&name=&preset_id=${PRESET_ID}`);
            await heos.applyGroupPreset(KEY);

            expect(written(heos)).to.deep.equal([
                `heos://group/apply_group_preset?preset_id=${PRESET_ID}\n`,
                `heos://group/apply_group_preset?preset_id=${PRESET_ID}\n`,
            ]);
            expect(heos.raiseLeaderFailures.called).to.equal(false);
        });

        it('sends the leader if it is a player of the preset', async () => {
            const heos = await withPreset('-2');
            await heos.applyGroupPreset(KEY);

            expect(written(heos)).to.deep.equal([`heos://group/apply_group_preset?preset_id=${PRESET_ID}&leader=-2\n`]);
        });

        it('accepts a numeric leader value', async () => {
            const heos = await withPreset(1);
            await heos.applyGroupPreset(KEY);

            expect(written(heos)).to.deep.equal([`heos://group/apply_group_preset?preset_id=${PRESET_ID}&leader=1\n`]);
        });

        it('clears the request time of an apply with leader', async () => {
            const heos = await withPreset('-2');
            await heos.applyGroupPreset(KEY);
            await answer(heos, 'group/apply_group_preset', `gid=-2&name=&preset_id=${PRESET_ID}&leader=-2`);

            expect(heos.request_time).to.deep.equal({});
        });

        for (const leader of ['', '  ', null]) {
            it(`lets HEOS choose the leader if the leader state is ${JSON.stringify(leader)}`, async () => {
                const heos = await withPreset(leader);
                await heos.applyGroupPreset(KEY);

                expect(written(heos)).to.deep.equal([`heos://group/apply_group_preset?preset_id=${PRESET_ID}\n`]);
            });
        }

        it('warns and lets HEOS choose if the leader is not a player of the preset', async () => {
            const heos = await withPreset('99');
            const warn = sinon.spy(heos, 'logWarn');
            await heos.applyGroupPreset(KEY);

            expect(written(heos)).to.deep.equal([`heos://group/apply_group_preset?preset_id=${PRESET_ID}\n`]);
            expect(warn.calledOnce).to.equal(true);
            expect(warn.firstCall.args[0]).to.include('99');
        });

        it('sends nothing for an unknown preset', async () => {
            const heos = await withPreset();
            await heos.applyGroupPreset('unknown');

            expect(written(heos)).to.deep.equal([]);
        });
    });

    describe('update', () => {
        /**
         * Connected adapter whose object and state writes are recorded.
         *
         * @returns {Promise<object>} the Heos adapter instance
         */
        async function recording() {
            const heos = await connected();
            heos.extendObjectAsync = sinon.stub().resolves();
            heos.setStateChangedAsync = sinon.stub().resolves();
            heos.setStateAsync = sinon.stub().resolves();
            heos.getChannelsOfAsync = sinon.stub().resolves([]);
            heos.delObjectAsync = sinon.stub().resolves();
            return heos;
        }

        const PAYLOAD = [
            {
                preset_id: PRESET_ID,
                name: 'Garden',
                state: 'Inactive',
                devices: [
                    { name: 'Living room', pid: 582866552 },
                    { name: 'Unavailable' },
                    { name: 'Office', pid: -2 },
                ],
            },
        ];

        it('stores the player ids of each preset, without unavailable players', async () => {
            const heos = await recording();
            await heos.updateGroupPresets(PAYLOAD);

            expect(heos.setStateChangedAsync.calledWith(`group_presets.${KEY}.pids`, '582866552,-2', true)).to.equal(
                true,
            );
            expect(
                heos.setStateChangedAsync.calledWith(
                    `group_presets.${KEY}.players`,
                    'Living room, Unavailable, Office',
                    true,
                ),
            ).to.equal(true);
            expect(heos.group_preset_pids).to.deep.equal({ [KEY]: ['582866552', '-2'] });
        });

        it('creates a writable leader state per preset, but never writes its value', async () => {
            const heos = await recording();
            await heos.updateGroupPresets(PAYLOAD);

            const leaderObject = heos.extendObjectAsync
                .getCalls()
                .find(call => call.args[0] === `group_presets.${KEY}.leader`);
            expect(leaderObject, 'leader object').to.not.equal(undefined);
            expect(leaderObject.args[1].common).to.include({ type: 'string', read: true, write: true });
            const leaderWrites = [...heos.setStateChangedAsync.getCalls(), ...heos.setStateAsync.getCalls()].filter(
                call => String(call.args[0]).endsWith('.leader'),
            );
            expect(leaderWrites).to.deep.equal([]);
        });
    });
});
