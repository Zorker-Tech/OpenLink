#!/bin/sh
set -eu

# Zero is the only product-facing runtime contract. Translate the private
# engine variables here so compose files and operators never need to know the
# implementation's upstream names. The binary remains private to the
# ZOKERBASE image and is intentionally not part of the public API.
if [ -n "${ZERO_ETCD_ENDPOINTS:-}" ]; then export ETCD_ENDPOINTS="$ZERO_ETCD_ENDPOINTS"; fi
if [ -n "${ZERO_MINIO_ADDRESS:-}" ]; then export MINIO_ADDRESS="$ZERO_MINIO_ADDRESS"; fi
if [ -n "${ZERO_MINIO_REGION:-}" ]; then export MINIO_REGION="$ZERO_MINIO_REGION"; fi
if [ -n "${ZERO_MINIO_ACCESS_KEY_ID:-}" ]; then export MINIO_ACCESS_KEY_ID="$ZERO_MINIO_ACCESS_KEY_ID"; fi
if [ -n "${ZERO_MINIO_SECRET_ACCESS_KEY:-}" ]; then export MINIO_SECRET_ACCESS_KEY="$ZERO_MINIO_SECRET_ACCESS_KEY"; fi

exec /milvus/bin/milvus "$@"
