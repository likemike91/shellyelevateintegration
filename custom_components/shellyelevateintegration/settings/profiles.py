"""Settings profiles: named, reusable sets of display settings.

One profile can be marked as the default; it is offered (pre-selected) when a new display
is added, so every display starts with the same configuration.

A profile can also hold files for file settings (such as the thinking sound). They are kept next
to the profile store and uploaded with `settings.file` when the profile is applied.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
import shutil
from typing import Any
import uuid

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import STORAGE_DIR, Store
from homeassistant.util.hass_dict import HassKey

from ..api import SettingDef
from ..const import DOMAIN
from .schema import file_keys, per_device_keys

STORAGE_KEY = f"{DOMAIN}.profiles"
STORAGE_VERSION = 1
FILES_DIR = f"{DOMAIN}.profile_files"
# the display takes at most 512 KB per file
MAX_FILE_BYTES = 512 * 1024

type FileSender = Callable[..., Awaitable[Any]]
"""Runs a display command, like ShellyElevateIntegrationDevice.async_command."""

type FileUpload = tuple[str, bytes] | dict[str, Any]
"""A file for a profile: (name, data), or a panel upload {name, data_b64}."""

DATA_PROFILES: HassKey[ProfileManager] = HassKey(f"{DOMAIN}_profiles")
_LOCK: HassKey[asyncio.Lock] = HassKey(f"{DOMAIN}_profiles_lock")


class ProfileManager:
    """Stores profiles in .storage (and therefore in HA backups)."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize."""
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY, private=True)
        # in .storage so the files are part of HA backups like the profiles
        self._files_dir = Path(hass.config.path(STORAGE_DIR, FILES_DIR))
        self.profiles: dict[str, dict[str, Any]] = {}
        self.default_profile_id: str | None = None
        self.last_schema: list[dict[str, Any]] | None = None
        """Settings schema the displays sent last, for the profile editor while none is online."""

    async def async_load(self) -> None:
        """Load from storage."""
        data = await self._store.async_load() or {}
        self.profiles = data.get("profiles", {})
        self.default_profile_id = data.get("default")
        if self.default_profile_id not in self.profiles:
            self.default_profile_id = None
        self.last_schema = data.get("schema")

    async def _async_save(self) -> None:
        data: dict[str, Any] = {"profiles": self.profiles, "default": self.default_profile_id}
        if self.last_schema is not None:
            data["schema"] = self.last_schema
        await self._store.async_save(data)

    async def async_remember_schema(self, schema: list[dict[str, Any]]) -> None:
        """Keep the schema of the displays for when none of them is online."""
        if schema != self.last_schema:
            self.last_schema = schema
            await self._async_save()

    def get(self, profile_id: str) -> dict[str, Any]:
        """Return a profile or raise."""
        if profile_id not in self.profiles:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="profile_not_found",
                translation_placeholders={"profile": profile_id},
            )
        return self.profiles[profile_id]

    def find(self, id_or_name: str) -> str:
        """Resolve a profile id from an id or a (case-insensitive) name."""
        if id_or_name in self.profiles:
            return id_or_name
        for pid, profile in self.profiles.items():
            if profile["name"].casefold() == id_or_name.casefold():
                return pid
        self.get(id_or_name)  # raises profile_not_found
        return id_or_name

    async def async_save_profile(
        self,
        name: str,
        settings: dict[str, Any],
        *,
        profile_id: str | None = None,
        schema: list[SettingDef] | None = None,
        make_default: bool | None = None,
        files: dict[str, FileUpload] | None = None,
    ) -> str:
        """Create or replace a profile. Per-device keys are always stripped.

        `files` sets the content of file settings. Stored files of keys that are no longer in the
        settings are deleted, and a file setting without a file is dropped: a name alone cannot be
        applied.
        """
        skip = per_device_keys(schema)
        now = datetime.now(UTC).isoformat()
        profile_id = profile_id or uuid.uuid4().hex[:12]
        existing = self.profiles.get(profile_id, {})
        settings = {k: v for k, v in settings.items() if k not in skip}
        uploads = {key: _decode_upload(key, value) for key, value in (files or {}).items() if key not in skip}
        stored: dict[str, dict[str, Any]] = dict(existing.get("files") or {})
        for key, (file_name, data) in uploads.items():
            await self.hass.async_add_executor_job(self._write_file, profile_id, key, data)
            stored[key] = {"name": file_name, "size": len(data)}
        for key in [key for key in stored if key not in settings and key not in uploads]:
            await self.hass.async_add_executor_job(self._delete_file, profile_id, key)
            del stored[key]
        for key in file_keys(schema) - set(stored):
            settings.pop(key, None)
        for key, info in stored.items():
            settings[key] = info["name"]
        profile: dict[str, Any] = {
            "name": name,
            "settings": settings,
            "created": existing.get("created", now),
            "updated": now,
        }
        if stored:
            profile["files"] = stored
        self.profiles[profile_id] = profile
        if make_default or (make_default is None and self.default_profile_id is None and not existing):
            self.default_profile_id = profile_id
        elif make_default is False and self.default_profile_id == profile_id:
            self.default_profile_id = None
        await self._async_save()
        return profile_id

    async def async_delete(self, profile_id: str) -> None:
        """Delete a profile."""
        self.get(profile_id)
        del self.profiles[profile_id]
        if self.default_profile_id == profile_id:
            self.default_profile_id = None
        await self._async_save()
        await self.hass.async_add_executor_job(shutil.rmtree, self._files_dir / profile_id, True)

    async def async_set_default(self, profile_id: str | None) -> None:
        """Mark a profile as default (None clears)."""
        if profile_id is not None:
            self.get(profile_id)
        self.default_profile_id = profile_id
        await self._async_save()

    def settings_for_device(
        self,
        profile_id: str,
        schema: list[SettingDef] | None,
        known_keys: set[str] | None = None,
    ) -> dict[str, Any]:
        """The profile settings that apply to a display."""
        profile = self.get(profile_id)
        skip = per_device_keys(schema)
        return {
            k: v for k, v in profile["settings"].items() if k not in skip and (known_keys is None or k in known_keys)
        }

    def files(self, profile_id: str) -> dict[str, str]:
        """File settings of a profile: key -> file name."""
        return {key: info["name"] for key, info in (self.get(profile_id).get("files") or {}).items()}

    async def async_read_file(self, profile_id: str, key: str) -> bytes:
        """Content of a stored file."""
        try:
            return await self.hass.async_add_executor_job((self._files_dir / profile_id / key).read_bytes)
        except OSError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="profile_file_missing",
                translation_placeholders={"key": key, "profile": self.get(profile_id)["name"]},
            ) from err

    async def async_upload_files(self, profile_id: str, keys: set[str] | dict[str, Any], send: FileSender) -> None:
        """Upload the files of a profile for the given keys with `settings.file`."""
        for key, name in self.files(profile_id).items():
            if key in keys:
                data = await self.async_read_file(profile_id, key)
                await send("settings.file", key=key, name=name, data_b64=base64.b64encode(data).decode())

    def _write_file(self, profile_id: str, key: str, data: bytes) -> None:
        folder = self._files_dir / profile_id
        folder.mkdir(parents=True, exist_ok=True)
        part = folder / f"{key}.part"
        part.write_bytes(data)
        part.replace(folder / key)

    def _delete_file(self, profile_id: str, key: str) -> None:
        (self._files_dir / profile_id / key).unlink(missing_ok=True)

    def as_list(self) -> list[dict[str, Any]]:
        """All profiles for the panel / services."""
        return [
            {"id": pid, "default": pid == self.default_profile_id, **profile}
            for pid, profile in sorted(self.profiles.items(), key=lambda item: item[1]["name"].casefold())
        ]


def _decode_upload(key: str, value: FileUpload) -> tuple[str, bytes]:
    """(name, data) of a file for a profile; raises when it is empty or too large."""
    if isinstance(value, dict):
        try:
            data = base64.b64decode(str(value.get("data_b64") or ""), validate=True)
        except (binascii.Error, ValueError):
            data = b""
        name = str(value.get("name") or "")
    else:
        name, data = value
    if not data or len(data) > MAX_FILE_BYTES:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="profile_file_invalid",
            translation_placeholders={"key": key},
        )
    return (name.strip() or "file")[:64], data


async def async_get_profile_manager(hass: HomeAssistant) -> ProfileManager:
    """Return the (lazily loaded) profile manager."""
    if (manager := hass.data.get(DATA_PROFILES)) is not None:
        return manager
    lock = hass.data.setdefault(_LOCK, asyncio.Lock())
    async with lock:
        if (manager := hass.data.get(DATA_PROFILES)) is None:
            manager = ProfileManager(hass)
            await manager.async_load()
            hass.data[DATA_PROFILES] = manager
    return manager
