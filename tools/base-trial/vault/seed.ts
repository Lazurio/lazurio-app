// Trial only (lazurio-app#97): an account and one login item on a Vaultwarden server, made the way
// a Bitwarden client makes them (PBKDF2-SHA256 master key, HKDF-stretched keys, AES-256-CBC with
// HMAC-SHA256, an RSA key pair), so the server holds a real encrypted vault. Prints the account as
// JSON. Usage: node seed.ts <server> <email> <master password> <item uri> <item user> <item password>
import * as NodeCrypto from "node:crypto";

const [server = "", email = "", password = "", uri = "", user = "", secret = ""] =
  process.argv.slice(2);
const ITERATIONS = 600_000;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const masterKey = NodeCrypto.pbkdf2Sync(password, email.toLowerCase(), ITERATIONS, 32, "sha256");
const masterPasswordHash = b64(NodeCrypto.pbkdf2Sync(masterKey, password, 1, 32, "sha256"));
// HKDF-Expand only: the master key is already the pseudorandom key.
const expand = (prk: Uint8Array, info: string) =>
  NodeCrypto.createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
const stretched = { enc: expand(masterKey, "enc"), mac: expand(masterKey, "mac") };

// EncString type 2: AES-256-CBC, HMAC-SHA256 over the IV and the cipher text.
const encrypt = (data: Uint8Array, key: { enc: Uint8Array; mac: Uint8Array }) => {
  const iv = NodeCrypto.randomBytes(16);
  const cipher = NodeCrypto.createCipheriv("aes-256-cbc", key.enc, iv);
  const text = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = NodeCrypto.createHmac("sha256", key.mac).update(Buffer.concat([iv, text])).digest();
  return `2.${b64(iv)}|${b64(text)}|${b64(mac)}`;
};

const userKey = NodeCrypto.randomBytes(64);
const userKeys = { enc: userKey.subarray(0, 32), mac: userKey.subarray(32) };
const pair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = b64(pair.publicKey.export({ type: "spki", format: "der" }));
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" });

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const json = typeof body !== "string";
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: {
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      ...headers,
    },
    body: json ? JSON.stringify(body) : body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`);
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
};

// Vaultwarden 1.37: without mail, the verification step answers with the token itself.
const verification = await fetch(`${server}/identity/accounts/register/send-verification-email`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ email, name: "Lazurio trial", receiveMarketingEmails: false }),
});
if (!verification.ok) throw new Error(`verification: ${verification.status}`);
const emailVerificationToken = (await verification.json()) as string;
const key = encrypt(userKey, stretched);
const keys = { publicKey, encryptedPrivateKey: encrypt(privateKey, userKeys) };
await post("/identity/accounts/register/finish", {
  email,
  emailVerificationToken,
  email_verification_token: emailVerificationToken,
  masterPasswordHash,
  masterPasswordHint: null,
  userSymmetricKey: key,
  kdf: 0,
  kdfIterations: ITERATIONS,
  userAsymmetricKeys: keys,
});
const token = await post(
  "/identity/connect/token",
  new URLSearchParams({
    grant_type: "password",
    username: email,
    password: masterPasswordHash,
    scope: "api offline_access",
    client_id: "web",
    deviceType: "10",
    deviceIdentifier: NodeCrypto.randomUUID(),
    deviceName: "lazurio-trial",
  }).toString(),
);
const text = (value: string) => encrypt(Buffer.from(value), userKeys);
// The cipher names the account it is encrypted for: the token's subject.
const accessToken = String(token["access_token"]);
const userId = String(
  (JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString()) as { sub: string })
    .sub,
);
const item = await post(
  "/api/ciphers",
  {
    type: 1,
    encryptedFor: userId,
    name: text("Trial sign-in"),
    notes: null,
    favorite: false,
    reprompt: 0,
    login: { username: text(user), password: text(secret), uris: [{ uri: text(uri), match: null }] },
  },
  { authorization: `Bearer ${accessToken}` },
);
process.stdout.write(`${JSON.stringify({ email, item: item["id"] })}\n`);
