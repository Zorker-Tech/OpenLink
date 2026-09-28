/**
 * The effort a request is asked for at.
 *
 * The level travels with the request rather than being decided here, and this middleware only sees that it is one of the
 * levels the platform knows.
 */
import { createLogger } from "../../context/index.ts";
import "../base.ts";

const logger = createLogger("@slate/chat-inference/effort-level-middleware");
