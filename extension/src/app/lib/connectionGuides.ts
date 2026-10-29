// Plain-language guide shown under the BigQuery "Sign in with" dropdown: how the chosen
// method works, what you need, and where it fits.

export interface ConnectionGuide {
  how: string;
  needs: string[];
  goodFor: string[];
  avoid?: string[];
}

export const BIGQUERY_AUTH_GUIDES: Record<string, ConnectionGuide> = {
  adc: {
    how: "Uses the login you made with the gcloud CLI. dbui reads the credentials file and turns it into short-lived BigQuery tokens, refreshing them automatically. It acts as you, with exactly your permissions.",
    needs: [
      "The gcloud CLI, signed in once with: gcloud auth application-default login",
      "Pick ~/.config/gcloud/application_default_credentials.json in Key file (⌘⇧G in the picker to type the path)",
    ],
    goodFor: ["Company accounts where you can't create OAuth clients or keys", "Day-to-day use on your own Mac"],
    avoid: ["Shared or borrowed computers: the file grants access as you until you sign out of gcloud"],
  },
  "access-token": {
    how: "You paste a short-lived token; dbui sends it with each request. Nothing is refreshed and it's kept in memory only.",
    needs: ["Run gcloud auth print-access-token and paste the ya29… output"],
    goodFor: ["A quick one-off look", "Trying dbui before setting anything up"],
    avoid: ["Long sessions: it expires after about an hour and you paste a new one"],
  },
  "chrome-profile": {
    how: "Chrome's built-in Google sign-in gives dbui a token for the account signed in to Chrome (top right of the window), after one consent screen.",
    needs: [
      "An OAuth client registered for this extension in a Google Cloud project you control",
      "The right Google account signed in to Chrome itself, not just to the BigQuery website",
    ],
    goodFor: ["Personal projects where you're the admin", "A team that publishes its own build of dbui"],
    avoid: ["Company accounts where you can't create an OAuth client: use gcloud login instead"],
  },
  "web-auth": {
    how: "A Google sign-in popup where you pick any account. dbui keeps the refresh token (per your Secrets setting) so you don't sign in every time.",
    needs: ["An OAuth client (web application) registered for this extension"],
    goodFor: ["Edge, Brave or Arc", "Switching between several Google accounts"],
    avoid: ["Company accounts where you can't create an OAuth client"],
  },
  "service-account": {
    how: "dbui signs requests with a service account's private key and acts as that service account, not as you.",
    needs: ["A service account JSON key file with BigQuery roles on the project"],
    goodFor: ["Projects you administer", "Automation-style access with narrow, dedicated roles"],
    avoid: [
      "Company production: long-lived keys are often banned by policy, and anyone with the file has the access",
      "Storing the key in the browser on a shared machine",
    ],
  },
  impersonate: {
    how: "You sign in as yourself (Chrome sign-in), then Google issues a token for a service account you're allowed to act as.",
    needs: ["Chrome sign-in set up (OAuth client)", "The Service Account Token Creator role on the target service account"],
    goodFor: ["Teams that grant access through service accounts instead of personal roles", "Testing what a service account can see"],
    avoid: ["Setups without an OAuth client, since it builds on Chrome sign-in"],
  },
  wif: {
    how: "Exchanges a credential from AWS, Azure or another identity provider for a Google token. Some configs run a local program, which is why it needs the runner.",
    needs: ["The dbui runner (not wired up yet)", "An external_account config from your Google Cloud admin"],
    goodFor: ["Organisations that federate cloud identities instead of issuing Google keys"],
  },
};
