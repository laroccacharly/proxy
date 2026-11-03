import { bunKeyring, layer } from "effect-lib/credentials"

// The OS keyring the Pi server reads OPENAI_API_KEY from, after the environment.
export const keyringLayer = layer(bunKeyring())
