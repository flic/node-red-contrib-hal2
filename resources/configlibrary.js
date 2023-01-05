function isStatusItem(item) {
    return ((item.type == 'both') || (item.type == 'status') || (item.type == 'loopback_both') || (item.id == '1'));
}

function isCommandItem(item) {
    return ((item.type == 'both') || (item.type == 'command') || (item.type == 'loopback_both') || (item.type == 'loopback_command'));
}

