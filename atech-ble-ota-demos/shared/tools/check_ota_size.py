# PlatformIO post-build check: the application image must fit the OTA slot
# declared in the partition table, with a safety margin, and both OTA slots
# must be the same size (an image that fits ota_0 must also fit ota_1).
# Used by both demos and by the AI builder workspaces (extra_scripts = post:...).
Import("env")

import os

MARGIN = 64 * 1024


def parse_size(text):
    value = text.strip().lower()
    multiplier = 1
    if value.endswith("k"):
        multiplier, value = 1024, value[:-1]
    elif value.endswith("m"):
        multiplier, value = 1024 * 1024, value[:-1]
    return int(value, 0) * multiplier


def ota_slots(table_path):
    slots = {}
    with open(table_path) as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fields = [field.strip() for field in line.split(",")]
            if len(fields) < 5:
                continue
            name, ptype, subtype, _offset, size = fields[:5]
            if ptype == "app" and subtype in ("ota_0", "ota_1"):
                slots[subtype] = parse_size(size)
    return slots


def check_image(source, target, env):
    firmware = str(target[0])
    project_dir = env.subst("$PROJECT_DIR")
    table = env.GetProjectOption("board_build.partitions", "partitions.csv")
    table_path = table if os.path.isabs(table) else os.path.join(project_dir, table)
    slots = ota_slots(table_path)
    if "ota_0" not in slots or "ota_1" not in slots:
        print("[atech] ERROR: %s has no ota_0/ota_1 app partitions" % table_path)
        env.Exit(1)
    if slots["ota_0"] != slots["ota_1"]:
        print("[atech] ERROR: OTA slots differ (ota_0 %d, ota_1 %d bytes); an OTA image must fit both" % (slots["ota_0"], slots["ota_1"]))
        env.Exit(1)
    slot = min(slots.values())
    size = os.path.getsize(firmware)
    limit = slot - MARGIN
    if size > limit:
        print("[atech] ERROR: firmware.bin is %d bytes but the OTA slot allows %d (%d-byte slot minus a %d-byte margin)" % (size, limit, slot, MARGIN))
        env.Exit(1)
    print("[atech] firmware.bin %d bytes fits the %d-byte OTA slot (%d bytes free after a %d-byte margin)" % (size, slot, limit - size, MARGIN))


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", check_image)
