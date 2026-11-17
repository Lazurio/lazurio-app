# Tailnets of Lazurio App set by IT (Windows)

An Organization's IT can tell Lazurio App which of the Organization's tailnets to join on its Windows computers. This is a temporary path for an alpha at a client. It ends when Lazurio App gets a person's tailnets from their Lazurio account ([ADR 0008](../adr/0008-tailnets-from-a-directory.md), point 6).

The policy only says where the tailnets are. It grants nobody access:

- Only a member of the Organization can sign in to its tailnet, with their Lazurio account.
- A new computer reaches the Organization's Environments only after the Organization approves it.

## The policy

|         |                                                    |
| ------- | -------------------------------------------------- |
| Key     | `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Lazurio\App` |
| Value   | `Tailnets`                                         |
| Type    | `REG_SZ` (string)                                  |
| Content | a JSON array of tailnets, on one line              |

Each tailnet has three fields:

- `tailnet`: the tailnet's name, as Lazurio gives it to the Organization: lower-case letters, digits and hyphens, unique in the array and none of the device names Windows reserves (`con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`);
- `controlUrl`: the tailnet's control server, an `https://` address without a port;
- `domains`: the DNS suffixes of the Organization's Environments, in ASCII (an international name in its `xn--` form).

```text
[{"tailnet":"<organization>","controlUrl":"https://headscale.<organization>.lazurio.io","domains":["<organization>.lazurio.io"]}]
```

Lazurio gives the Organization the exact values. Lazurio App takes only control servers and suffixes below `lazurio.io` or `lazurio.ai`. It refuses any other entry and writes the reason to its log.

## How Lazurio App uses it

- It reads the policy each time it starts. A policy that exists replaces the tailnets built into the app.
- A policy that is not valid JSON in this shape joins no tailnet at all.
- Only an administrator can write under `HKEY_LOCAL_MACHINE\SOFTWARE\Policies`, so the policy stays an administrator's setting. Lazurio App is installed per user, though, and a program running with the person's rights can change the app itself; the policy does not protect against that.
- Updates of Lazurio App keep the policy, because it lives outside the app.

## Deploying it

Through Group Policy, use a registry preference (Computer Configuration → Preferences → Windows Settings → Registry) with the key, value, type and content above.

Through a device-management tool, or by hand in an elevated PowerShell:

```powershell
$tailnets = '[{"tailnet":"<organization>","controlUrl":"https://headscale.<organization>.lazurio.io","domains":["<organization>.lazurio.io"]}]'
New-Item -Path 'HKLM:\SOFTWARE\Policies\Lazurio\App' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Lazurio\App' -Name 'Tailnets' -Value $tailnets -Type String
```

To check it, run `reg query "HKLM\SOFTWARE\Policies\Lazurio\App" /v Tailnets`. Start Lazurio App again afterwards.

The tailnet then shows in the app's column. Lazurio App's log names the source with the line `tailnets { source: 'policy', … }`.
