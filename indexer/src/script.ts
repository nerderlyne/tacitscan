// Minimal Bitcoin script parser, just enough to extract a Tacit envelope
// from a Taproot script-path leaf script. Tacit envelopes follow the
// inscription-style `<pubkey> OP_CHECKSIG OP_FALSE OP_IF ... OP_ENDIF`
// shape; we only need to walk pushes inside that frame.

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_IF = 0x63;
const OP_NOTIF = 0x64;
const OP_ENDIF = 0x68;

export type ScriptOp =
  | { kind: "push"; data: Uint8Array }
  | { kind: "op"; opcode: number };

export function decodeScript(script: Uint8Array): ScriptOp[] {
  const ops: ScriptOp[] = [];
  let i = 0;
  while (i < script.length) {
    const b = script[i]!;
    i++;
    if (b === OP_0) {
      ops.push({ kind: "push", data: new Uint8Array(0) });
      continue;
    }
    if (b >= 0x01 && b <= 0x4b) {
      // OP_PUSHBYTES_N
      if (i + b > script.length) throw new Error("truncated push");
      ops.push({ kind: "push", data: script.slice(i, i + b) });
      i += b;
      continue;
    }
    if (b === OP_PUSHDATA1) {
      if (i + 1 > script.length) throw new Error("truncated PUSHDATA1");
      const n = script[i]!;
      i++;
      if (i + n > script.length) throw new Error("truncated PUSHDATA1 data");
      ops.push({ kind: "push", data: script.slice(i, i + n) });
      i += n;
      continue;
    }
    if (b === OP_PUSHDATA2) {
      if (i + 2 > script.length) throw new Error("truncated PUSHDATA2");
      const n = script[i]! | (script[i + 1]! << 8);
      i += 2;
      if (i + n > script.length) throw new Error("truncated PUSHDATA2 data");
      ops.push({ kind: "push", data: script.slice(i, i + n) });
      i += n;
      continue;
    }
    if (b === OP_PUSHDATA4) {
      if (i + 4 > script.length) throw new Error("truncated PUSHDATA4");
      const n =
        script[i]! |
        (script[i + 1]! << 8) |
        (script[i + 2]! << 16) |
        (script[i + 3]! << 24);
      if (n < 0) throw new Error("oversized PUSHDATA4");
      i += 4;
      if (i + n > script.length) throw new Error("truncated PUSHDATA4 data");
      ops.push({ kind: "push", data: script.slice(i, i + n) });
      i += n;
      continue;
    }
    if (b === OP_1NEGATE) {
      ops.push({ kind: "push", data: new Uint8Array([0x81]) });
      continue;
    }
    if (b >= OP_1 && b <= OP_16) {
      ops.push({ kind: "push", data: new Uint8Array([b - OP_1 + 1]) });
      continue;
    }
    ops.push({ kind: "op", opcode: b });
  }
  return ops;
}

// Extract the spending pubkey from a Tacit envelope-bearing leaf script.
// Canonical shape is `<32-byte pubkey> OP_CHECKSIG OP_FALSE OP_IF ...`, so
// the spender is the first 32-byte push that precedes an OP_CHECKSIG. The
// pubkey is the on-chain witness signer — same key the OP_CHECKSIG verifies
// against. Returns the 64-hex pubkey, or null if the script doesn't match
// the canonical shape (very old or shape-malformed witnesses).
const OP_CHECKSIG = 0xac;

export function extractSpendingPubkey(script: Uint8Array): string | null {
  let ops;
  try {
    ops = decodeScript(script);
  } catch {
    return null;
  }
  for (let i = 0; i < ops.length - 1; i++) {
    const a = ops[i]!;
    const b = ops[i + 1]!;
    if (a.kind === "push" && a.data.length === 32 && b.kind === "op" && b.opcode === OP_CHECKSIG) {
      let hex = "";
      for (const byte of a.data) hex += byte.toString(16).padStart(2, "0");
      return hex;
    }
  }
  return null;
}

// Extract the inner pushes between `OP_FALSE OP_IF ... OP_ENDIF`.
// Returns null if no such frame exists in the script. We track IF/ENDIF
// depth so a nested OP_IF inside the envelope (none in Tacit, but
// defensively safe) doesn't terminate early.
export function extractEnvelopeFrame(ops: ScriptOp[]): Uint8Array[] | null {
  for (let i = 0; i < ops.length - 1; i++) {
    const a = ops[i]!;
    const b = ops[i + 1]!;
    if (
      a.kind === "push" &&
      a.data.length === 0 && // OP_FALSE / OP_0
      b.kind === "op" &&
      b.opcode === OP_IF
    ) {
      const pushes: Uint8Array[] = [];
      let depth = 1;
      for (let j = i + 2; j < ops.length; j++) {
        const o = ops[j]!;
        if (o.kind === "op") {
          if (o.opcode === OP_IF || o.opcode === OP_NOTIF) {
            depth++;
            continue;
          }
          if (o.opcode === OP_ENDIF) {
            depth--;
            if (depth === 0) return pushes;
            continue;
          }
          // Other opcodes inside the envelope frame are legal but ignored;
          // canonical Tacit only emits pushes.
          continue;
        }
        pushes.push(o.data);
      }
      // An unterminated frame is malformed.
      return null;
    }
  }
  return null;
}
