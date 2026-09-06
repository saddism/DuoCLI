import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annexBContainsType,
  mergeParameterSets,
  normalizeH264Frame,
  parameterSetsFromAnnexB,
} from '../dist/main/android-h264.js';

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]);
const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);

test('normalizes scrcpy codec config without emitting a fake video frame', () => {
  const sets = parameterSetsFromAnnexB(Buffer.concat([sps, pps]));
  assert.equal(sets.sps?.[4], 0x67);
  assert.equal(sets.pps?.[4], 0x68);
  assert.equal(annexBContainsType(Buffer.concat([sps, pps]), 5), false);
  assert.equal(normalizeH264Frame(Buffer.concat([sps, pps]), { config: true, keyFrame: false }, sets), null);
});

test('prefixes cached SPS/PPS to an IDR and marks only the IDR as key', () => {
  const sets = mergeParameterSets({ sps: null, pps: null }, parameterSetsFromAnnexB(Buffer.concat([sps, pps])));
  const frame = normalizeH264Frame(idr, { config: false, keyFrame: true }, sets);
  assert.ok(frame);
  assert.equal(frame.config, false);
  assert.equal(frame.keyFrame, true);
  assert.deepEqual([...frame.payload.subarray(0, sps.length)], [...sps]);
  assert.deepEqual([...frame.payload.subarray(sps.length, sps.length + pps.length)], [...pps]);
  assert.equal(frame.payload.at(-3), 0x65);
});

