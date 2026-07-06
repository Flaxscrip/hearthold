/**
 * Browser Keymaster — the member's own wallet, in the browser.
 *
 * The Knowledge Portal never holds a member's key. The member unlocks their own Archon wallet
 * (WalletWeb = localStorage) here, and Keymaster signs each KB request with `addProof` — a detached
 * Secp256k1 signature over the request. That signed object is byte-for-byte what the Warden's
 * `KbService` verifies, so DID control is proven end-to-end; the Mage only carries it.
 *
 * This mirrors the archon.social / react-wallet browser recipe: GatekeeperClient + WalletWeb +
 * CipherWeb. On archon.social the member's wallet is already in `localStorage['archon-keymaster']`.
 */

import Keymaster from '@didcid/keymaster';
import WalletWeb from '@didcid/keymaster/wallet/web';
import CipherWeb from '@didcid/cipher/web';
import GatekeeperClient from '@didcid/gatekeeper/client';

/** Minimal surface of the Keymaster methods we use (the package ships broader types). */
interface KeymasterLike {
  loadWallet(): Promise<unknown>;
  getCurrentId(): Promise<string | undefined>;
  resolveDID(id: string): Promise<{ didDocument?: { id?: string } }>;
  addProof<T extends object>(obj: T): Promise<T & { proof: unknown }>;
}

export interface Member {
  name: string;
  did: string;
}

let km: KeymasterLike | null = null;

/** Unlock the member's browser wallet and return their identity. Throws on a wrong passphrase. */
export async function connect(gatekeeperUrl: string, passphrase: string): Promise<Member> {
  const gatekeeper = new GatekeeperClient();
  await gatekeeper.connect({ url: gatekeeperUrl });
  const instance = new Keymaster({
    gatekeeper,
    wallet: new WalletWeb(),
    cipher: new CipherWeb(),
    passphrase,
  }) as unknown as KeymasterLike;

  await instance.loadWallet(); // validates the passphrase against the stored wallet

  const name = await instance.getCurrentId();
  if (!name) {
    throw new Error('This wallet has no identity yet — create one in the Archon wallet first.');
  }
  const did = (await instance.resolveDID(name)).didDocument?.id;
  if (!did) throw new Error('Could not resolve your DID from the node.');

  km = instance;
  return { name, did };
}

/** Sign a KB request statement with the member's key (proves DID control). */
export async function signStatement<T extends object>(statement: T): Promise<T & { proof: unknown }> {
  if (!km) throw new Error('Connect your wallet first.');
  return km.addProof(statement);
}

export function isConnected(): boolean {
  return km !== null;
}

export function disconnect(): void {
  km = null;
}
