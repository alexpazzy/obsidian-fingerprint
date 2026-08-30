// Password fallback hashing.
// Uses the renderer's Web Crypto API (window.crypto.subtle), not Node's crypto
// module, since this all happens in the Electron renderer process.

const PBKDF2_ITERATIONS = 150_000;
const HASH_ALGO = "SHA-256";
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

export function generateSalt(): string {
	const salt = new Uint8Array(SALT_BYTES);
	window.crypto.getRandomValues(salt);
	return bufferToHex(salt.buffer);
}

async function deriveBits(password: string, saltHex: string): Promise<ArrayBuffer> {
	const enc = new TextEncoder();
	const keyMaterial = await window.crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		{ name: "PBKDF2" },
		false,
		["deriveBits"]
	);
	const saltBytes = hexToBytes(saltHex);
	return window.crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt: saltBytes,
			iterations: PBKDF2_ITERATIONS,
			hash: HASH_ALGO,
		},
		keyMaterial,
		KEY_LENGTH_BITS
	);
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
	const bits = await deriveBits(password, saltHex);
	return bufferToHex(bits);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

export async function verifyPassword(
	password: string,
	saltHex: string,
	expectedHashHex: string
): Promise<boolean> {
	if (!saltHex || !expectedHashHex) return false;
	const actualHashHex = await hashPassword(password, saltHex);
	return timingSafeEqual(actualHashHex, expectedHashHex);
}
