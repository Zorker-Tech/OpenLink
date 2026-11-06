#!/usr/bin/env python3
"""Start Civilization 1.0.0's upstream Stage74 service for OpenLink memory."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import threading

from civilization.engine.persistence import FSYNC_EVERY_WRITE, MODE_IN_PROCESS
from civilization.engine.stages.stage49_persistent_inference_service import Stage49ServiceConfig
from civilization.engine.stages.stage51_runtime_management import Stage51RuntimeDescriptor
from civilization.engine.stages.stage59_access_control_audit import Stage59SecurityConfig
from civilization.engine.stages.stage61_async_jobs import Stage61JobConfig
from civilization.engine.stages.stage62_persistent_async_jobs import Stage62PersistenceConfig
from civilization.engine.stages.stage64_external_result_store import Stage64ResultStoreConfig
from civilization.engine.stages.stage66_batch_export import Stage66ExportConfig
from civilization.engine.stages.stage74_orion_memory_service import Stage74MemoryConfig, Stage74OrionMemoryService


class MemoryOnlyRuntime:
    """Keep the upstream inference routes explicit while OpenLink owns LLM calls."""

    def predict(self, _request):
        raise RuntimeError("decision inference is disabled in the OpenLink project-memory service")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    args = parser.parse_args()

    state_root = Path(args.state_dir).expanduser().resolve()
    state_root.mkdir(parents=True, exist_ok=True)
    token = os.environ.get("OPENLINK_CIVILIZATION_INTERNAL_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("OPENLINK_CIVILIZATION_INTERNAL_TOKEN must contain at least 32 characters")

    service = Stage74OrionMemoryService(
        runtime_factory=MemoryOnlyRuntime,
        descriptor=Stage51RuntimeDescriptor(
            package_manifest="openlink-memory-only",
            centroid_bundle="not-configured",
            label="openlink-project-memory-v1.0.0",
        ),
        config=Stage49ServiceConfig(
            host="127.0.0.1",
            port=0,
            capabilities={
                "project_memory": True,
                "decision_inference": False,
                "upstream_service": "Stage74OrionMemoryService",
                "upstream_version": "1.0.0",
            },
        ),
        security=Stage59SecurityConfig(
            bearer_token=token,
            require_token_for_predict=True,
            require_token_for_admin=True,
            require_token_for_metrics=True,
            audit_log_path=str(state_root / "audit.jsonl"),
        ),
        job_config=Stage61JobConfig(job_log_path=str(state_root / "jobs.jsonl")),
        persistence_config=Stage62PersistenceConfig(job_state_path=str(state_root / "jobs-state.json")),
        result_store_config=Stage64ResultStoreConfig(result_dir=str(state_root / "job-results")),
        export_config=Stage66ExportConfig(export_dir=str(state_root / "exports")),
        memory_config=Stage74MemoryConfig(
            global_store_path=None,
            session_persistence_dir=str(state_root / "orion-memory"),
            session_persistence_mode=MODE_IN_PROCESS,
            session_fsync=FSYNC_EVERY_WRITE,
            persist_traces=False,
        ),
    )
    httpd = service.start_background()
    host, port = httpd.server_address[:2]

    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda _signum, _frame: stopped.set())
    signal.signal(signal.SIGTERM, lambda _signum, _frame: stopped.set())
    print(json.dumps({"ready": True, "url": f"http://{host}:{port}"}), flush=True)

    try:
        stopped.wait()
    finally:
        service.shutdown()


if __name__ == "__main__":
    main()
