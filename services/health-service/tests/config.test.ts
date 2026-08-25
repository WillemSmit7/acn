import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devices, enabledDevices } from '../src/config/devices.js';

test('device ids are unique', () => {
  const ids = devices.map((device) => device.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('check addresses are unique and never management addresses', () => {
  const managementAddresses = new Set(devices.map((device) => device.managementAddress));
  const checkAddresses = devices.map((device) => device.checkAddress);

  assert.equal(new Set(checkAddresses).size, checkAddresses.length);
  for (const address of checkAddresses) {
    assert.ok(
      !managementAddresses.has(address),
      `${address} is a management address - a link failure would not be observable`,
    );
  }
});

test('enabledDevices returns only enabled devices', () => {
  assert.ok(enabledDevices().every((device) => device.enabled));
});
