// Must load before any @didcid/keymaster import — Keymaster/cipher rely on the Node `Buffer` global.
// A separate side-effect module guarantees it runs before the keymaster imports in App/keymaster.ts.
import { Buffer } from 'buffer';

(globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
