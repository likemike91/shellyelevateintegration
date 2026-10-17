"""Settings schema helpers."""

from __future__ import annotations

from typing import Any

from ..api import SettingDef
from ..api.app_schema import APP_RULES
from ..api.legacy_schema import LEGACY_SCHEMA

# Keys that identify a single display and must never be copied to another one, even when
# the schema does not say so (older app versions).
ALWAYS_PER_DEVICE = frozenset({"mqttDeviceId", "bluetoothProxyName", "device", "settingEverShown", "displayName"})
ALWAYS_SECRET = frozenset({"mqttPassword", "voiceAssistantToken"})
# settings that hold the name of an uploaded file (the file itself goes through settings.file)
APP_FILE_KEYS = frozenset(rule["key"] for rule in APP_RULES if rule.get("accept"))

# Used when no schema is given (legacy app, or callers that did not fetch one)
_LEGACY_DEFS = [SettingDef.from_dict(item) for item in LEGACY_SCHEMA]


def per_device_keys(schema: list[SettingDef] | None) -> set[str]:
    """Keys that must not leave the display they belong to."""
    return {item.key for item in schema or _LEGACY_DEFS if item.per_device} | ALWAYS_PER_DEVICE


def secret_keys(schema: list[SettingDef] | None) -> set[str]:
    """Keys holding secrets."""
    return {item.key for item in schema or _LEGACY_DEFS if item.secret} | ALWAYS_SECRET


def file_keys(schema: list[SettingDef] | None) -> set[str]:
    """Keys whose value is the name of an uploaded file."""
    return {item.key for item in schema or () if item.accept} | APP_FILE_KEYS


def portable(settings: dict[str, Any], schema: list[SettingDef] | None) -> dict[str, Any]:
    """Settings without per-device keys (safe to copy to another display).

    File settings are left out too: their value is only a name, the file stays on the display.
    """
    skip = per_device_keys(schema) | file_keys(schema)
    return {k: v for k, v in settings.items() if k not in skip}


def redact(settings: dict[str, Any], schema: list[SettingDef] | None) -> dict[str, Any]:
    """Replace secret values."""
    secret = secret_keys(schema)
    return {k: ("**REDACTED**" if k in secret and v else v) for k, v in settings.items()}


def diff(current: dict[str, Any], target: dict[str, Any]) -> list[dict[str, Any]]:
    """Keys whose value would change when applying `target`."""
    return [
        {"key": key, "current": current.get(key), "new": value}
        for key, value in sorted(target.items())
        if current.get(key) != value
    ]
