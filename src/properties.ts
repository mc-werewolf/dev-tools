import type { AddonProperties } from "@kairo-js/properties";

export const properties: AddonProperties = {
    id: "werewolf-dev-tools",
    metadata: {
        authors: ["shizuku86"],
    },
    header: {
        name: "Werewolf Dev Tools",
        description: "Provides development-only tools for Werewolf BDS testing.",
        version: {
            major: 0,
            minor: 1,
            patch: 0,
            prerelease: "dev",
        },
        min_engine_version: { major: 1, minor: 21, patch: 132 },
    },
    minecraftDependencies: [
        { module_name: "@minecraft/server", version: "2.8.0" },
        { module_name: "@minecraft/server-ui", version: "2.0.0" },
        { module_name: "@minecraft/server-gametest", version: "1.0.0-beta" },
    ],
    dependencies: {
        kairo: "^1.0.0-beta.0",
        "kairo-database": "^1.0.0-beta.0",
        "werewolf-gamemanager": "^0.1.0",
    },
    tags: ["official", "experimental"],
};
