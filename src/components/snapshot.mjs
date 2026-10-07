import { Right, Tag } from '../runtime/constants.mjs';
import { CapabilityHandle } from '../runtime/capability.mjs';

/**
 * Snapshot component.
 *
 * Turns an arbitrary engine state into a snapshot blob and back. It owns no
 * memory itself: it is granted a `store` handle (a memory region) and a
 * `log` stream handle, and everything else arrives as arguments. This is the
 * "snapshot" primitive from the b8g README reduced to a component.
 */
export const snapshotComponent = {
  name: 'snapshot',
  version: '0.1.0',
  requires: ['store', 'log'],
  provides: ['capture', 'restore', 'inspect'],
  factory(handles, api) {
    const { serializeSnapshot, deserializeSnapshot, inspectSnapshot } = api.snapshot;
    let captures = 0;

    function capture(state, name = 'capture') {
      const bytes = serializeSnapshot(state, name);
      const store = handles.store;
      store.require(Right.WRITE, 'snapshot capture');
      const region = store.target;
      if (bytes.length > region.size) {
        throw new Error(`snapshot of ${bytes.length}B exceeds store region of ${region.size}B`);
      }
      region.fill(0);
      region.write(0, bytes);
      captures++;
      handles.log.target.emit({ type: 'snapshot:capture', name, size: bytes.length });
      return { name, size: bytes.length, checksum: inspectSnapshot(bytes).checksum };
    }

    function restore(length) {
      const store = handles.store;
      store.require(Right.READ, 'snapshot restore');
      const region = store.target;
      const bytes = region.read(0, Math.min(length ?? region.size, region.size));
      return deserializeSnapshot(bytes);
    }

    function inspect(length) {
      const store = handles.store;
      store.require(Right.READ, 'snapshot inspect');
      const region = store.target;
      const bytes = region.read(0, Math.min(length ?? region.size, region.size));
      return inspectSnapshot(bytes);
    }

    return { capture, restore, inspect, get captures() { return captures; } };
  },
};

export function memoryHandle(region, rights, owner) {
  return new CapabilityHandle(Tag.Memory, region, rights, { name: region.name, owner });
}
