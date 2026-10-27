import { bunKeyring, make } from "effect-lib/credentials"
import { ApiKey as OpenAIApiKey } from "effect-lib/openai-image"

// Every api key the server sets on upstream requests.
export const auth = make([OpenAIApiKey])

export const keyringLayer = auth.layer(bunKeyring())
