from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from opensandbox_server.services.docker.port_allocator import with_port_binding_retry


def test_reallocates_after_confirmed_engine_conflict():
    first = {"18080": ("0.0.0.0", 44001)}
    second = {"18080": ("0.0.0.0", 44002)}
    failure = HTTPException(500, "Egress sidecar container failed to start")
    failure.__cause__ = RuntimeError("cannot bind tcp port :44001: address already in use")
    allocate = Mock(side_effect=[first, second])
    start = Mock(side_effect=[failure, "sidecar"])
    assert with_port_binding_retry(allocate, start) == (second, "sidecar")
    assert start.call_count == 2


def test_other_failures_are_not_retried():
    start = Mock(side_effect=RuntimeError("permission denied"))
    with pytest.raises(RuntimeError, match="permission denied"):
        with_port_binding_retry(lambda: {}, start)
    assert start.call_count == 1


def test_port_contention_has_a_bounded_retry_budget():
    start = Mock(side_effect=RuntimeError("port is already allocated"))
    with pytest.raises(RuntimeError, match="port is already allocated"):
        with_port_binding_retry(lambda: {}, start)
    assert start.call_count == 5
