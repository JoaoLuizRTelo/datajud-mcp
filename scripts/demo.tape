# VHS script (https://github.com/charmbracelet/vhs): `vhs scripts/demo.tape` writes docs/demo.gif
Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "./scripts/demo.sh 0713383-43.2025.8.07.0006"
Sleep 500ms
Enter
# DataJud + Claude take a while; trim the wait in post if you like.
Sleep 150s
Sleep 5s
