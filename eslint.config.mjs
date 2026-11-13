import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // service_role のクライアント（Webhook 用）は、署名の確認がある Webhook の受け口からだけ使う
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/supabase/admin", "**/supabase/admin"],
              importNames: ["getWebhookAdminClient"],
              message:
                "getWebhookAdminClient is only for src/app/api/stripe/webhook/route.ts (protected by signature verification). Use requireAdminClient() in admin Server Actions.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/api/stripe/webhook/route.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
