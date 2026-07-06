/**
 * Browser Keymaster — the member's own wallet, in the browser.
 *
 * The Knowledge Portal never holds a member's key. The member unlocks (or creates / recovers) their own
 * Archon wallet here (WalletWeb = localStorage), and Keymaster signs each KB request with `addProof` —
 * a detached Secp256k1 signature. That signed object is byte-for-byte what the Warden's `KbService`
 * verifies, so DID control is proven end-to-end; the Mage only carries it.
 *
 * Mirrors the archon.social / react-wallet recipe: GatekeeperClient + WalletWeb + CipherWeb, and the
 * same newWallet/recoverWallet/createId lifecycle. On archon.social the member's wallet is already in
 * `localStorage['archon-keymaster']`, so `connect` (unlock) is effectively SSO.
 */

import Keymaster from '@didcid/keymaster';
import WalletWeb from '@didcid/keymaster/wallet/web';
import CipherWeb from '@didcid/cipher/web';
import GatekeeperClient from '@didcid/gatekeeper/client';

/** Minimal surface of the Keymaster methods we use (the package ships broader types). */
interface KeymasterLike {
  loadWallet(): Promise<unknown>;
  newWallet(mnemonic?: string, overwrite?: boolean): Promise<unknown>;
  recoverWallet(): Promise<unknown>;
  createId(name: string, options?: { registry?: string }): Promise<unknown>;
  decryptMnemonic(): Promise<string>;
  listIds(): Promise<string[]>;
  getCurrentId(): Promise<string | undefined>;
  setCurrentId(name: string): Promise<unknown>;
  resolveDID(id: string): Promise<{ didDocument?: { id?: string } }>;
  addProof<T extends object>(obj: T): Promise<T & { proof: unknown }>;
}

export interface Member {
  name: string;
  did: string;
}

let km: KeymasterLike | null = null;

async function build(gatekeeperUrl: string, passphrase: string): Promise<KeymasterLike> {
  const gatekeeper = new GatekeeperClient();
  await gatekeeper.connect({ url: gatekeeperUrl });
  return new Keymaster({
    gatekeeper,
    wallet: new WalletWeb(),
    cipher: new CipherWeb(),
    passphrase,
  }) as unknown as KeymasterLike;
}

async function currentMember(): Promise<Member> {
  if (!km) throw new Error('not connected');
  const name = await km.getCurrentId();
  if (!name) throw new Error('This wallet has no current identity.');
  const did = (await km.resolveDID(name)).didDocument?.id;
  if (!did) throw new Error('Could not resolve your DID from the node.');
  return { name, did };
}

/** Unlock an existing browser wallet and return the current identity. Throws on a wrong passphrase. */
export async function connect(gatekeeperUrl: string, passphrase: string): Promise<Member> {
  const instance = await build(gatekeeperUrl, passphrase);
  await instance.loadWallet(); // validates the passphrase against the stored wallet
  km = instance;
  return currentMember();
}

/** Create a brand-new wallet + identity. Returns the identity and the mnemonic to back up. */
export async function createIdentity(
  gatekeeperUrl: string,
  passphrase: string,
  name: string,
  registry: string,
): Promise<{ member: Member; mnemonic: string }> {
  const instance = await build(gatekeeperUrl, passphrase);
  await instance.newWallet(undefined, true); // generate a fresh mnemonic + wallet
  const mnemonic = await instance.decryptMnemonic();
  await instance.createId(name, { registry });
  km = instance;
  return { member: await currentMember(), mnemonic };
}

/**
 * Recover an existing wallet from its mnemonic (seed phrase) — this is how you reuse an existing DID
 * (e.g. `flaxscrip`) in a fresh browser. Returns the recovered identity names; call `useIdentity` to
 * pick one. The seed is used locally and never leaves the browser.
 */
export async function recover(gatekeeperUrl: string, passphrase: string, mnemonic: string): Promise<string[]> {
  const instance = await build(gatekeeperUrl, passphrase);
  await instance.newWallet(mnemonic.trim(), true);
  await instance.recoverWallet(); // scans the ledger, restores all IDs from the seed
  km = instance;
  return instance.listIds();
}

/** Select which recovered identity to act as. */
export async function useIdentity(name: string): Promise<Member> {
  if (!km) throw new Error('Recover a wallet first.');
  await km.setCurrentId(name);
  return currentMember();
}

/** Sign a KB request statement with the member's key (proves DID control). */
export async function signStatement<T extends object>(statement: T): Promise<T & { proof: unknown }> {
  if (!km) throw new Error('Connect your wallet first.');
  return km.addProof(statement);
}

export function disconnect(): void {
  km = null;
}
