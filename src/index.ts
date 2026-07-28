import { system, world, type Player, type Vector3 } from "@minecraft/server";
import * as gameTest from "@minecraft/server-gametest";
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

type GameStateLike = {
    readonly status?: string;
    readonly players?: Record<string, unknown>;
};

const SESSION_TICKS = 20 * 60 * 20;
const LOBBY_BOTS: readonly BotSpec[] = [
    { name: "WerewolfDev_Seer", offset: { x: 1, y: 2, z: 1 } },
    { name: "WerewolfDev_Wolf", offset: { x: 3, y: 2, z: 1 } },
    { name: "WerewolfDev_Villager1", offset: { x: 5, y: 2, z: 1 } },
    { name: "WerewolfDev_Villager2", offset: { x: 7, y: 2, z: 1 } },
];

let activeSession: ActiveSession | undefined;

router.init(properties);

router.beforeEvents.startup.subscribe((ev) => {
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.list", listSession);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.disconnectAll", disconnectAll);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.move", movePlayer);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.stop", stopPlayer);
    ev.addonApi.register("werewolf-dev-tools:simulatedPlayers.chat", chatAsPlayer);
});

gameTest
    .registerAsync("WerewolfDevSim", "spawnLobbyBots", async (test) => {
        const players = startSession(test, LOBBY_BOTS);
        broadcast(
            `Spawned ${players.length} simulated players. Start the game from GameManager while this GameTest is running.`,
        );
        test.succeedOnTick(SESSION_TICKS);
    })
    .maxTicks(SESSION_TICKS + 20)
    .structureName("gametests:mediumglass");

gameTest
    .registerAsync("WerewolfDevSim", "startGameWithBots", async (test) => {
        const players = startSession(test, LOBBY_BOTS);

        const roleComposition = {
            seer: 1,
            werewolf: 1,
            villager: Math.max(1, getHumanPlayers().length + players.length - 2),
        };
        await tryGameManagerRequest("werewolf:devSetRoleComposition", { roleComposition });

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

function startSession(test: gameTest.Test, specs: readonly BotSpec[]): readonly SimulatedPlayer[] {
    disconnectAll();

    const players = specs.map((spec) => test.spawnSimulatedPlayer(spec.offset, spec.name));
    activeSession = {
        id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        test,
        startedAtTick: system.currentTick,
        players,
    };

    return players;
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
    const botNames = new Set(activeSession?.players.map((player) => player.name) ?? LOBBY_BOTS.map((bot) => bot.name));
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

function isCanceledResult<T>(value: T | CanceledResult): value is CanceledResult {
    return typeof value === "object" && value !== null && "canceled" in value;
}

function broadcast(message: string): void {
    world.sendMessage(`[werewolf-dev-tools] ${message}`);
}
