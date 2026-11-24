import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	// Optional: pin your own Cloudflare accountId if you have multiple accounts.
	// accountId: "<your-cloudflare-account-id>",
	worker: {
		name: "ntfy-worker",
		compatibilityDate: "2025-01-01",
		entrypoint: "src/worker.js",
		workersDev: true,
		observability: {
			enabled: true,
		},
		env: {
			NTFY_TOKEN: bindings.secret(),
			TOPIC_ROOM: bindings.durableObject({
				worker: "ntfy-worker",
				exportName: "TopicRoom",
			}),
		},
		exports: {
			TopicRoom: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
