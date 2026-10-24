import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../packages/protocol/src/index.js';
import {
  initialIdleEnd, isPhoneSessionId, mayApplyPhoneResponse, phoneModeLabel, readAcquire, readFrame, readPhoneMap, readStatus,
  phoneAssociationKey, resolvePhoneDevice, takeoverHardEnd, textProblem, touchLease, writePhoneMap,
} from '../apps/desktop/ui/phone-client.js';

const device = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const bot = '00000000-0000-4000-8000-0000000000aa';

test('phone preview contract is device-only and rejects a control session', () => {
  assert.deepEqual(parseInput('phonePreview', { deviceId: device }), { deviceId: device });
  assert.throws(() => parseInput('phonePreview', { deviceId: device, sessionId: device }));
  assert.throws(() => parseInput('phonePreview', { deviceId: device, phoneId: 'google-play-validation' }));
});

test('phone association stays on real authorized computers and does not invent devices', () => {
  const devices = [
    { id: device, revoked_at: null },
    { id: other, revoked_at: null },
  ];
  assert.equal(resolvePhoneDevice({ savedDeviceId: other, executionDeviceId: device, devices }).deviceId, other);
  assert.equal(resolvePhoneDevice({ savedDeviceId: 'missing', executionDeviceId: device, devices }).deviceId, null);
  assert.equal(resolvePhoneDevice({ savedDeviceId: device, devices: [{ id: device, revoked_at: '2026-10-23T00:00:00Z' }, { id: other, revoked_at: null }] }).deviceId, null);
  assert.equal(resolvePhoneDevice({ devices }).source, 'none');
  assert.equal(resolvePhoneDevice({ devices: [] }).deviceId, null);
  assert.equal(resolvePhoneDevice({ devices: [devices[0]] }).deviceId, null);
  assert.equal(resolvePhoneDevice({ executionDeviceId: 'missing', devices: [devices[0]] }).deviceId, null);
  assert.notEqual(phoneAssociationKey('https://a.example', 'u'), phoneAssociationKey('https://b.example', 'u'));
  assert.notEqual(phoneAssociationKey('https://a.example', 'u'), phoneAssociationKey('https://a.example', 'v'));
  assert.equal(phoneAssociationKey('https://a.example/', 'u'), phoneAssociationKey('https://a.example', 'u'));
  const stored = writePhoneMap(readPhoneMap('{"bad":1}'), bot, device);
  assert.deepEqual(stored, { [bot]: device });
  assert.deepEqual(readPhoneMap(JSON.stringify(stored)), stored);
});

test('preview does not renew a takeover lease; frames are fixed 720x1280 jpeg', () => {
  const now = 1_700_000_000_000;
  const hard = takeoverHardEnd(now, now + 20 * 60 * 1000);
  assert.equal(hard, now + 10 * 60 * 1000);
  assert.equal(takeoverHardEnd(now, now + 60_000), now + 60_000);
  const idle = touchLease('frame', now, hard, now);
  assert.equal(touchLease('preview', now + 1000, hard, idle), idle);
  assert.equal(touchLease('input', now + 1000, hard, idle), now + 1000 + 45_000);
  assert.equal(textProblem('你好'), '只能发送英文、数字和符号');
  assert.equal(textProblem('ok'), '');
  assert.equal(readStatus({ available: true, occupied: false, phoneId: 'google-play-validation', label: '验证机' }).phoneId, 'google-play-validation');
  assert.equal(readStatus({}).phoneId, undefined);
  const session = readAcquire({ sessionId: '00000000-0000-4000-8000-000000000003', expiresAt: now + 1000 }, now);
  assert.equal(session?.sessionId, '00000000-0000-4000-8000-000000000003');
  assert.equal(readAcquire({ sessionId: 'not-a-uuid', expiresAt: now + 1000 }, now), null);
  assert.equal(readFrame({ mime: 'image/jpeg', data: '/9j/aaaaaaaaaaaa', width: 720, height: 1280 })?.width, 720);
  assert.equal(readFrame({ mime: 'image/png', data: '/9j/aaaaaaaaaaaa', width: 720, height: 1280 }), null);
  assert.equal(readFrame({ mime: 'image/jpeg', data: '/9j/aaaaaaaaaaaa', width: 1080, height: 1920 }), null);
  const opened = initialIdleEnd(now, hard);
  assert.equal(opened, now + 45_000);
  assert.equal(touchLease('preview', now + 1000, hard, opened), opened);
  assert.equal(readStatus({ status: 'occupied', phoneId: 'google-play-validation' }).occupied, true);
  assert.equal(readStatus({ status: 'available' }).available, true);
  assert.equal(isPhoneSessionId('00000000-0000-4000-8000-000000000003'), true);
  assert.equal(isPhoneSessionId('not-a-session'), false);
});

test('switching bot or device invalidates old preview, acquire and frames', () => {
  const scope = { epoch: 2, botId: bot, deviceId: device };
  const preview = { epoch: 2, botId: bot, deviceId: device, mounted: true, hidden: false, phase: 'preview' as const };
  assert.equal(mayApplyPhoneResponse(scope, preview, 'preview'), true);
  assert.equal(mayApplyPhoneResponse(scope, preview, 'acquire'), true);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, deviceId: other }, 'preview'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, botId: other }, 'acquire'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, epoch: 3 }, 'frame'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, hidden: true }, 'preview'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, mounted: false }, 'acquire'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, phase: 'live' }, 'preview'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, phase: 'live' }, 'frame'), true);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, phase: 'live', deviceId: other }, 'frame'), false);
  assert.equal(mayApplyPhoneResponse(scope, { ...preview, hidden: true }, 'status'), true);
  assert.equal(phoneModeLabel({ hasDevices: true, deviceSelected: true, online: true, hidden: false, phase: 'preview', pending: false, occupied: false, available: true }), '只读预览，不占用控制权');
  assert.equal(phoneModeLabel({ hasDevices: true, deviceSelected: true, online: true, hidden: false, phase: 'live', pending: false, occupied: false, available: true }), '正在接管');
  assert.equal(phoneModeLabel({ hasDevices: false, deviceSelected: false, online: false, hidden: false, phase: 'preview', pending: false, occupied: false, available: false }), '没有已授权的执行电脑');
  const second = '00000000-0000-4000-8000-0000000000bb';
  assert.deepEqual(writePhoneMap(writePhoneMap({}, bot, device), second, other), { [bot]: device, [second]: other });
});
