/**
 * The user's own computer as a box.
 *
 * A user has one computer, and it is addressed by the platform's own id: what is listed is that one machine, and a
 * request for it resolves only while it is connected — a request for anything else, or for a machine that is not there,
 * resolves to nothing rather than to a guess.
 */

/** The id the user's own computer is addressed by. */
export const DEFAULT_SLATE_COMPUTER_ID = "this-computer";

/** The label the computer gets when the caller does not name one. */
const DEFAULT_COMPUTER_LABEL = "this computer";

/** What the factory is given: the box, and, when the caller knows them, its label and its connection. */
type SingleUserComputerArgs<Box> = {
  box: Box;
  label?: string;
  isConnected?: () => boolean;
};

/** One user's computer, listed and resolved as the platform's single-machine port expects. */
export function createSingleUserComputer<Box>(args: SingleUserComputerArgs<Box>) {
  const id = DEFAULT_SLATE_COMPUTER_ID;
  const computerLabel = args.label ?? DEFAULT_COMPUTER_LABEL;
  const probeConnection = (): boolean => args.isConnected?.() ?? true;
  return {
    list: () => [{ id, label: computerLabel, connected: probeConnection() }],
    resolve(requestedId?: string) {
      const askedForAnother = requestedId !== undefined && requestedId !== id;
      if (askedForAnother || !probeConnection()) return undefined;
      return { id, label: computerLabel, box: args.box };
    },
  };
}
