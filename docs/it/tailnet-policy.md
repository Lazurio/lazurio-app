# Tailnets of Lazurio App set by IT (Windows)

An Organization's IT can tell Lazurio App which of the Organization's tailnets to join on its Windows computers. This is a temporary path for Lazurio App (Alpha) at a client. It ends when Lazurio App gets a person's tailnets from their Lazurio account ([ADR 0008](../adr/0008-tailnets-from-a-directory.md), point 6).

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

## Without an administrator: the person's own setting

A temporary exception that Matěj decided on 2026-11-18 ([ADR 0008](../adr/0008-tailnets-from-a-directory.md), point 6). For Lazurio App (Alpha) at a client where nobody can write the policy, the signed-in person sets the same value for themselves. Like the policy, it ends when Lazurio App gets a person's tailnets from their Lazurio account.

|         |                                          |
| ------- | ---------------------------------------- |
| Key     | `HKEY_CURRENT_USER\Software\Lazurio\App` |
| Value   | `Tailnets`                               |
| Type    | `REG_SZ` (string)                        |
| Content | the same JSON array as the policy        |

- Lazurio App reads it only when its helper confirms that the computer has no policy. A policy, when IT sets one, always wins, and a policy that cannot be read (for example a value of another type) keeps the setting unread.
- Lazurio App checks it exactly like the policy: only control servers and suffixes below `lazurio.io` or `lazurio.ai`. A setting that does not decode joins no tailnet at all.
- It grants nobody access, like the policy: signing in to the tailnet still needs the person's Lazurio account and the Organization's membership, and reach still needs the Organization's approval of the computer.
- Any program running with the person's rights can change it. It can point the app only at Lazurio's own control servers, though.
- Lazurio sends the file with the Organization's values to the person privately. The address of a customer Organization's network is never in this repository or in a published build.

### The file Lazurio sends: `lazurio-app-tailnets.reg`

A registry file in the format of Windows' Registry Editor, saved as UTF-16 LE with a byte order mark (as Registry Editor writes it) or as ANSI when the values are plain ASCII, which Lazurio's always are. Inside the value, every `"` is written as `\"`:

```text
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Lazurio\App]
"Tailnets"="[{\"tailnet\":\"<organization>\",\"controlUrl\":\"https://headscale.<organization>.lazurio.io\",\"domains\":[\"<organization>.lazurio.io\"]}]"
```

What the person does (not yet tried on a Windows computer; the first trial follows on 2026-11-18):

1. Save the file, for example to Downloads.
2. Double-click it. If Windows asks whether Registry Editor may make changes, answer **Yes**. This prompt comes only for an account that is an administrator.
3. Registry Editor asks whether to continue: **Yes**. It then says the keys and values were added: **OK**.
4. Quit Lazurio App (Alpha) (close its window, or choose Quit in the notification area where the app has it) and start it again. The Organization's network then shows in the app's column.

The same in one PowerShell command, without a file and without an administrator:

```powershell
$tailnets = '[{"tailnet":"<organization>","controlUrl":"https://headscale.<organization>.lazurio.io","domains":["<organization>.lazurio.io"]}]'
New-Item -Path 'HKCU:\Software\Lazurio\App' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Lazurio\App' -Name 'Tailnets' -Value $tailnets -Type String
```

Lazurio App's log then names the source with the line `tailnets { source: 'user-setting', … }`. To remove the setting, run `Remove-ItemProperty -Path 'HKCU:\Software\Lazurio\App' -Name 'Tailnets'`.
