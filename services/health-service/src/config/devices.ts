import type { Device } from '../models/types.js';

/**
 * The devices the Health Service monitors.
 *
 * Single source of truth for lab addressing - do not scatter IPs through the
 * codebase. Increment 1 loads this from code; dynamic device discovery is
 * deliberately out of scope.
 *
 * checkAddress vs managementAddress:
 *   managementAddress (172.20.20.x) is the containerlab management network and
 *   stays up even when the data plane breaks. checkAddress is a loopback or
 *   data-plane address reachable only THROUGH the emulated network, so a link
 *   failure is genuinely observable. ./lab/deploy.sh installs the host routes
 *   that make those addresses reachable from this process.
 */
export const devices: Device[] = [
  {
    id: 'r1',
    name: 'Router 1',
    type: 'router',
    managementAddress: '172.20.20.11',
    checkAddress: '10.255.0.1',
    enabled: true,
  },
  {
    id: 'r2',
    name: 'Router 2',
    type: 'router',
    managementAddress: '172.20.20.12',
    checkAddress: '10.255.0.2',
    enabled: true,
  },
  {
    id: 'r3',
    name: 'Router 3',
    type: 'router',
    managementAddress: '172.20.20.13',
    checkAddress: '10.255.0.3',
    enabled: true,
  },
  {
    id: 'pc1',
    name: 'PC 1',
    type: 'host',
    managementAddress: '172.20.20.21',
    checkAddress: '10.0.1.2',
    enabled: true,
  },
  {
    id: 'pc2',
    name: 'PC 2',
    type: 'host',
    managementAddress: '172.20.20.22',
    checkAddress: '10.0.3.2',
    enabled: true,
  },
];

export function enabledDevices(): Device[] {
  return devices.filter((device) => device.enabled);
}
