import { system, world, type Player, type Vector3 } from "@minecraft/server";
import * as gameTest from "@minecraft/server-gametest";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { router, type CanceledResult } from "@kairo-js/router";
import { properties } from "./properties";

type SimulatedPlayer = gameTest.SimulatedPlayer;

type SimulatedPlayerSummary = {
    readonly id: string;
    readonly name: string;
    readonly location: Vector3;
};

type SessionSummary = {
    readonly id: string;
    readonly startedAtTick: number;
    readonly players: readonly SimulatedPlayerSummary[];
};

type ActiveSession = {
    readonly id: string;
    readonly test: gameTest.Test;
    readonly startedAtTick: number;
    players: SimulatedPlayer[];
};

type BotSpec = {
    readonly name: string;
    readonly offset: Vector3;
};

type MoveArgs = {
    readonly name: string;
    readonly westEast?: number;
    readonly northSouth?: number;
    readonly speed?: number;
};

type ChatArgs = {
    readonly name: string;
    readonly message: string;
};

type PlayerFormArgs = {
    readonly playerId?: unknown;
    readonly playerName?: unknown;
};

type GameStateLike = {
    readonly status?: string;
    readonly players?: Record<string, unknown>;
};

const SESSION_TICKS = 20 * 60 * 20;
const DEFAULT_BOT_COUNT = 4;
const MAX_BOT_COUNT = 20;
const BOT_NAME_PREFIX = "WerewolfDevBot";
const GAMETEST_ORIGIN = { x: 0, y: 0, z: 0 } as const;
const GAMETEST_CLEAR_RADIUS = 16;
const GAMETEST_CLEAR_HEIGHT = 16;
const REGISTER_SETUP_ACTION_RETRY_TICKS = 20;
const REGISTER_SETUP_ACTION_MAX_ATTEMPTS = 20;

let activeSession: ActiveSession | undefined;
let configuredBotCount = DEFAULT_BOT_COUNT;
let nextBotNumber = 1;
let setupActionRegistered = false;

router.init(properties);

router.beforeEvents.startup.subscribe((ev) => {
    ev.addonApi.register("werewolf-dev-tools:openSimulatedPlayersForm", openSimulatedPlayersForm);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.list", listSession);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.disconnectAll", disconnectAll);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.add", addSimulatedPlayers);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.move", movePlayer);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.stop", stopPlayer);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.chat", chatAsPlayer);
});

router.afterEvents.addonActivate.subscribe(() => {
    void registerGameManagerSetupAction();
});

gameTest
    .registerAsync("WerewolfDevSim", "spawnLobbyBots", async (test) => {
        const players = startSession(test, DEFAULT_BOT_COUNT);
        broadcast(
            `Spawned ${players.length} simulated players. Start the game from GameManager while this GameTest is running.`,
        );
        test.succeedOnTick(SESSION_TICKS);
    })
    .maxTicks(SESSION_TICKS + 20)
    .structureName("gametests:mediumglass");

gameTest
    .registerAsync("WerewolfDevSim", "spawnConfiguredBots", async (test) => {
        const players = startSession(test, configuredBotCount);
        broadcast(
            `Spawned ${players.length} simulated players. Start the game from GameManager while this GameTest is running.`,
        );
        test.succeedOnTick(SESSION_TICKS);
    })
    .maxTicks(SESSION_TICKS + 20)
    .structureName("gametests:mediumglass");

gameTest
    .registerAsync("WerewolfDevSim", "startGameWithBots", async (test) => {
        const players = startSession(test, configuredBotCount);

        const playerIds = [...getHumanPlayers(), ...players].map((player) => player.id);
        const result = await tryGameManagerRequest<GameStateLike>("werewolf:devStartGame", { playerIds });
        if (!result || isCanceledResult(result) || result.status !== "running") {
            broadcast("GameManager dev APIs were unavailable. Bots are spawned; start the game manually.");
        } else {
            broadcast(`Started Werewolf game with ${Object.keys(result.players ?? {}).length} players.`);
        }

        test.succeedOnTick(SESSION_TICKS);
    })
    .maxTicks(SESSION_TICKS + 20)
    .structureName("gametests:mediumglass");

async function registerGameManagerSetupAction(attempt = 0): Promise<void> {
    if (setupActionRegistered) return;
    try {
        const result = await router.request("werewolf-gamemanager", "werewolf:registerSetupFormAction", {
            id: "werewolf-dev-tools:simulatedPlayers",
            label: "werewolf-dev-tools.setup.simulatedPlayers.label",
            description: "werewolf-dev-tools.setup.simulatedPlayers.description",
            order: 900,
            apiName: "werewolf-dev-tools:openSimulatedPlayersForm",
        });
        if (isCanceledResult(result)) {
            scheduleSetupActionRegistrationRetry(attempt);
            return;
        }
        setupActionRegistered = true;
        return;
    } catch (err) {
        if (attempt >= REGISTER_SETUP_ACTION_MAX_ATTEMPTS) {
            console.warn("[werewolf-dev-tools] Failed to register GameManager setup action:", err);
        }
        scheduleSetupActionRegistrationRetry(attempt);
    }
}

function scheduleSetupActionRegistrationRetry(attempt: number): void {
    if (attempt >= REGISTER_SETUP_ACTION_MAX_ATTEMPTS) return;
    system.runTimeout(() => {
        void registerGameManagerSetupAction(attempt + 1);
    }, REGISTER_SETUP_ACTION_RETRY_TICKS);
}

async function openSimulatedPlayersForm(args: PlayerFormArgs): Promise<void> {
    const player = findTargetPlayer(args);
    if (!player) {
        throw new Error("[werewolf-dev-tools] Target player was not found");
    }

    const session = listSession();
    const form = new ActionFormData()
        .title("Werewolf Dev Tools")
        .body(formatSessionBody(session))
        .button("Spawn simulated players")
        .button("Add simulated players")
        .button("Disconnect all simulated players")
        .button("Close");

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection === 0) {
        await openSpawnBotsForm(player);
        return;
    }
    if (response.selection === 1) {
        await openAddBotsForm(player);
        return;
    }
    if (response.selection === 2) {
        const disconnected = disconnectAll();
        player.sendMessage(`[werewolf-dev-tools] Disconnected ${disconnected} simulated players.`);
    }
}

async function openSpawnBotsForm(player: Player): Promise<void> {
    const form = new ModalFormData()
        .title("Spawn simulated players")
        .slider("Bot count", 1, MAX_BOT_COUNT, {
            valueStep: 1,
            defaultValue: configuredBotCount,
        })
        .toggle("Start game after spawning", {
            defaultValue: false,
        })
        .submitButton("Start GameTest");

    const response = await form.show(player);
    if (response.canceled || !response.formValues) return;

    configuredBotCount = readCount(response.formValues[0], configuredBotCount);
    const shouldStartGame = response.formValues[1] === true;
    runGameTest(player, shouldStartGame ? "startGameWithBots" : "spawnConfiguredBots");
}

async function openAddBotsForm(player: Player): Promise<void> {
    if (!activeSession) {
        player.sendMessage("[werewolf-dev-tools] No active GameTest session. Spawn a new session first.");
        return;
    }

    const form = new ModalFormData()
        .title("Add simulated players")
        .slider("Bot count", 1, MAX_BOT_COUNT, {
            valueStep: 1,
            defaultValue: 1,
        })
        .submitButton("Spawn");

    const response = await form.show(player);
    if (response.canceled || !response.formValues) return;

    const count = readCount(response.formValues[0], 1);
    try {
        const beforeCount = activeSession.players.length;
        const session = addSimulatedPlayers({ count });
        const afterCount = session?.players.length ?? beforeCount;
        player.sendMessage(`[werewolf-dev-tools] Added ${afterCount - beforeCount} simulated players.`);
    } catch (err) {
        player.sendMessage(`[werewolf-dev-tools] ${err instanceof Error ? err.message : String(err)}`);
    }
}

function startSession(test: gameTest.Test, count: number): readonly SimulatedPlayer[] {
    disconnectAll();

    const players = spawnPlayers(test, count, 0);
    activeSession = {
        id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        test,
        startedAtTick: system.currentTick,
        players,
    };

    return players;
}

function addSimulatedPlayers(args?: { readonly count?: unknown }): SessionSummary | undefined {
    if (!activeSession) {
        throw new Error("No active GameTest session. Spawn a new session first.");
    }
    activeSession.players = activeSession.players.filter((player) => player.isValid);
    const players = spawnPlayers(activeSession.test, readCount(args?.count, 1), activeSession.players.length);
    activeSession.players.push(...players);
    return listSession();
}

function spawnPlayers(test: gameTest.Test, count: number, existingCount: number): SimulatedPlayer[] {
    return createBotSpecs(count, existingCount).map((spec) => test.spawnSimulatedPlayer(spec.offset, spec.name));
}

function createBotSpecs(count: number, existingCount: number): BotSpec[] {
    return Array.from({ length: count }, (_value, index) => ({
        name: createBotName(),
        offset: createBotOffset(existingCount + index),
    }));
}

function createBotOffset(index: number): Vector3 {
    return {
        x: 1 + (index % 5) * 2,
        y: 2,
        z: 1 + Math.floor(index / 5) * 2,
    };
}

function createBotName(): string {
    const usedNames = new Set([
        ...world.getPlayers().map((player) => player.name),
        ...(activeSession?.players.map((player) => player.name) ?? []),
    ]);
    while (true) {
        const name = `${BOT_NAME_PREFIX}${nextBotNumber}`;
        nextBotNumber += 1;
        if (!usedNames.has(name)) return name;
    }
}

function listSession(): SessionSummary | undefined {
    if (!activeSession) return undefined;
    activeSession.players = activeSession.players.filter((player) => player.isValid);

    return {
        id: activeSession.id,
        startedAtTick: activeSession.startedAtTick,
        players: activeSession.players.map((player) => ({
            id: player.id,
            name: player.name,
            location: player.location,
        })),
    };
}

function disconnectAll(): number {
    const players = activeSession?.players ?? [];
    let disconnected = 0;
    for (const player of players) {
        if (!player.isValid) continue;
        try {
            player.disconnect();
            disconnected += 1;
        } catch (err) {
            console.warn("[werewolf-dev-tools] Failed to disconnect simulated player:", err);
        }
    }
    activeSession = undefined;
    nextBotNumber = 1;
    return disconnected;
}

function movePlayer(args: MoveArgs): boolean {
    const player = findActivePlayer(args.name);
    if (!player) return false;
    player.move(args.westEast ?? 0, args.northSouth ?? 1, args.speed);
    return true;
}

function stopPlayer(args: { readonly name: string }): boolean {
    const player = findActivePlayer(args.name);
    if (!player) return false;
    player.stopMoving();
    player.stopInteracting();
    player.stopUsingItem();
    return true;
}

function chatAsPlayer(args: ChatArgs): boolean {
    const player = findActivePlayer(args.name);
    if (!player) return false;
    player.chat(args.message);
    return true;
}

function findActivePlayer(name: string): SimulatedPlayer | undefined {
    const session = listSession();
    if (!session || !activeSession) return undefined;
    return activeSession.players.find((player) => player.name === name);
}

function getHumanPlayers(): Player[] {
    const botNames = new Set(activeSession?.players.map((player) => player.name) ?? []);
    return world.getPlayers().filter((player) => !botNames.has(player.name));
}

async function tryGameManagerRequest<T = unknown>(apiName: string, args?: unknown): Promise<T | CanceledResult | undefined> {
    try {
        return await router.request<T>("werewolf-gamemanager", apiName, args);
    } catch (err) {
        console.warn(`[werewolf-dev-tools] ${apiName} failed:`, err);
        return undefined;
    }
}

function isCanceledResult(value: unknown): value is CanceledResult {
    return typeof value === "object" && value !== null && "canceled" in value;
}

function findTargetPlayer(args: PlayerFormArgs): Player | undefined {
    return world.getPlayers().find((player) =>
        player.id === args.playerId
        || player.name === args.playerName
    );
}

function readCount(raw: unknown, fallback: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.max(1, Math.min(MAX_BOT_COUNT, Math.trunc(raw)));
}

function formatSessionBody(session: SessionSummary | undefined): string {
    if (!session) {
        return `No active simulated player session.\nConfigured spawn count: ${configuredBotCount}`;
    }
    const names = session.players.map((player) => player.name).join(", ");
    return [
        `Active session: ${session.players.length} simulated players`,
        `Configured spawn count: ${configuredBotCount}`,
        names ? `Players: ${names}` : "Players: none",
    ].join("\n");
}

function runGameTest(player: Player, testName: "spawnConfiguredBots" | "startGameWithBots"): void {
    try {
        clearGameTestOrigin(player);
        player.runCommand(
            `execute positioned ${GAMETEST_ORIGIN.x} ${GAMETEST_ORIGIN.y} ${GAMETEST_ORIGIN.z} run gametest run WerewolfDevSim:${testName}`,
        );
        player.sendMessage(
            `[werewolf-dev-tools] Starting ${testName} at ${formatGameTestOrigin()} with ${configuredBotCount} simulated players.`,
        );
    } catch (err) {
        player.sendMessage(`[werewolf-dev-tools] Failed to start GameTest: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function clearGameTestOrigin(player: Player): void {
    const minX = GAMETEST_ORIGIN.x - GAMETEST_CLEAR_RADIUS;
    const minY = GAMETEST_ORIGIN.y;
    const minZ = GAMETEST_ORIGIN.z - GAMETEST_CLEAR_RADIUS;
    const maxX = GAMETEST_ORIGIN.x + GAMETEST_CLEAR_RADIUS;
    const maxY = GAMETEST_ORIGIN.y + GAMETEST_CLEAR_HEIGHT;
    const maxZ = GAMETEST_ORIGIN.z + GAMETEST_CLEAR_RADIUS;
    player.runCommand(`fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} air replace`);
}

function formatGameTestOrigin(): string {
    return `${GAMETEST_ORIGIN.x}, ${GAMETEST_ORIGIN.y}, ${GAMETEST_ORIGIN.z}`;
}

function broadcast(message: string): void {
    world.sendMessage(`[werewolf-dev-tools] ${message}`);
}
