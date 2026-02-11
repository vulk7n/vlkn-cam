fx_version 'cerulean'
game 'gta5'

author 'vlkn'
description 'Free Cam'
version '0.2.2'

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

server_script 'server/sv_freecam.lua'

dependencies {
    'ox_lib',
    'screenshot-basic'
}

lua54 'yes'