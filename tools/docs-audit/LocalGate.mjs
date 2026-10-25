#!/usr/bin/env node
import { runGateCli } from "./GateCli.mjs";

process.exitCode = await runGateCli("LocalGate");
