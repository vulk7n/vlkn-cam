shared_script '@WaveShield/resource/include.lua'
shared_script '@WaveShield/resource/waveshield.js'

fx_version 'cerulean'
game 'gta5'

author 'vlkn'
description 'Free Cam'
version '4.5.0'

shared_scripts {
    '@ox_lib/init.lua',
    'config.lua',
}

client_scripts {
    'cl_freecam.lua'
}

ui_page 'ui/index.html'

files {
    'ui/index.html',
    'ui/style.css',
    'ui/script.js',
}

server_scripts {
    'server/sv_bridge.lua',
    'server/sv_freecam.js'
}

dependencies {
    'ox_lib',
    'screenshot-basic'
}

lua54 'yes'
