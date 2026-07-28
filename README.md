# Werewolf Dev Tools

BDS development addon for private tools used while testing Werewolf worlds.

The first toolset provides GameTest `SimulatedPlayer` instances for solo BDS testing.

## GameTest Scenarios

- `WerewolfDevSim:spawnLobbyBots`: spawns lobby bots and keeps the GameTest session open for manual GameManager testing.
- `WerewolfDevSim:startGameWithBots`: spawns bots and tries to start GameManager through dev APIs when a dev GameManager build is loaded.

`SimulatedPlayer` can only be created from a GameTest `Test` context, so this addon keeps the active session state here instead of putting GameTest code in GameManager.
