# The passkey run of the vault trial

After `steps-fill.json`'s sign-in, with `TRIAL_PASSKEY=1`, the trial opens `https://localhost:18091/`
(the trial's loopback certificate) and calls `navigator.credentials.create` and then
`navigator.credentials.get` for the relying party `localhost`.

```sh
TRIAL_EXPLORE=1 TRIAL_PASSKEY=1 \
PASSKEY_STEPS='[{"click":"Save passkey as new login"},{"wait":"3000"}]' \
PASSKEY_GET_STEPS='[{"click":"Passkey Item - Lazurio trial"},{"wait":"3000"}]' \
./run.sh "$(sed '$d' steps-fill.json | sed 's/,{"click":"Fill"},{"wait":"2500"}//')"
```
