import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export function clientKey(address: string): string {
  let key = address;
  if (isIP(address) === 6) {
    // Expand valid IPv6, including an optional dotted IPv4 tail, so spelling and
    // compression cannot change the first 64 bits used by both limiters.
    const hex = address.replace(/\d+\.\d+\.\d+\.\d+$/, tail => {
      const bytes = tail.split(".").map(Number);
      return `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    }).split("%")[0];
    const [left, right] = hex.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const groups = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
    key = `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
  }
  return createHash("sha256").update(key).digest("hex");
}
