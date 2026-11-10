# MCP metrics

## Metric projection

Discovery, tool-call and resource-fetch metrics are emitted from Slate-owned inputs. Mode classification prefers a named tool, then a search pattern, then a server detail request, and otherwise the catalog. Missing result counts and byte sizes stay absent rather than becoming zero; failures without a reason use `unknown`.

## Privacy and scope

Disabled discovery emits no eligibility or prompt-tool measurements. Directory access is counted only for paths inside the MCP directory segment. Failure logs keep the selected tool, mode, retryability, duration, server/tool names and a bounded caller-provided message.

## Verification

`tests/packages/agent-mcp-metrics.test.ts` pins mode selection, success/failure counters, optional measurements, retry labels, discovery gating, spill outcomes, failure logs and directory path filtering.
