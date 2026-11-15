// A self-signed certificate made at run time for the end-to-end tests' own HTTPS server, so no key
// enters Git and no tool beyond Node is needed on any platform: X.509 v3, P-256 with ECDSA SHA-256
// and the given names. The tests ignore certificate errors, so a fixed validity reads no clock.
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node's crypto signs the certificate.
import * as NodeCrypto from "node:crypto";

const encodeLength = (length: number): Uint8Array => {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: Array<number> = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const tlv = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(tag), encodeLength(body.length), body]);
};

const sequence = (...parts: ReadonlyArray<Uint8Array>) => tlv(0x30, ...parts);
const ecdsaWithSha256 = sequence(
  tlv(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02)),
);
const commonName = (name: string) =>
  sequence(
    tlv(0x31, sequence(tlv(0x06, Uint8Array.of(0x55, 0x04, 0x03)), tlv(0x0c, Buffer.from(name)))),
  );
const utcTime = (time: string) => tlv(0x17, Buffer.from(time));
const subjectAltNames = (names: ReadonlyArray<string>) =>
  sequence(
    tlv(0x06, Uint8Array.of(0x55, 0x1d, 0x11)),
    tlv(0x04, sequence(...names.map((name) => tlv(0x82, Buffer.from(name))))),
  );

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/gu)
      ?.join("\n") ?? ""
  }\n-----END ${label}-----\n`;

export interface Certificate {
  readonly cert: string;
  readonly key: string;
}

export const selfSigned = (names: ReadonlyArray<string>): Certificate => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = NodeCrypto.randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const name = commonName("lazurio-app e2e");
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Uint8Array.of(0x02))),
    tlv(0x02, serial),
    ecdsaWithSha256,
    name,
    sequence(utcTime("000101000000Z"), utcTime("491231235959Z")),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, sequence(subjectAltNames(names))),
  );
  const signature = NodeCrypto.sign("sha256", tbs, privateKey);
  const cert = pem(
    "CERTIFICATE",
    sequence(tbs, ecdsaWithSha256, tlv(0x03, Uint8Array.of(0), signature)),
  );
  if (!new NodeCrypto.X509Certificate(cert).verify(publicKey)) {
    throw new Error("the end-to-end certificate does not verify");
  }
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};
