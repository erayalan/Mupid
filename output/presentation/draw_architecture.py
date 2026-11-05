from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

OUT = Path(__file__).parent
S = 2
im = Image.new('RGB', (1920*S, 1080*S), 'black')
d = ImageDraw.Draw(im)
FONT = '/System/Library/Fonts/Helvetica.ttc'

def text(x, y, value, size=28, anchor='mm', bold=False):
    f = ImageFont.truetype(FONT, int(size*S), index=1 if bold else 0)
    d.text((x*S,y*S), value, font=f, fill='white', anchor=anchor)

def line(points, width=2):
    d.line([(int(x*S),int(y*S)) for x,y in points], fill='white', width=width*S)

def arrow(points, both=False):
    line(points)
    ends = [(points[-2],points[-1])]
    if both: ends.append((points[1],points[0]))
    for a,b in ends:
        theta = math.atan2(b[1]-a[1],b[0]-a[0])
        line([(b[0]-13*math.cos(theta-.45),b[1]-13*math.sin(theta-.45)),b,
              (b[0]-13*math.cos(theta+.45),b[1]-13*math.sin(theta+.45))])

def box(bounds):
    d.rounded_rectangle(tuple(int(v*S) for v in bounds), radius=18*S, outline='white', width=2*S)

def person(x,y):
    d.ellipse(((x-15)*S,(y-38)*S,(x+15)*S,(y-8)*S),outline='white',width=2*S)
    d.arc(((x-32)*S,(y-2)*S,(x+32)*S,(y+49)*S),180,360,fill='white',width=2*S)
    line([(x-32,y+23),(x+32,y+23)])

text(960, 91, 'So, what happens in the background?', 52, 'mm', True)
text(960, 161, 'Mupid connects personal agents and helps them make an introduction.', 27, 'mm')

person(330,257)
text(330,307,'You',25)
person(1590,257)
text(1590,307,'Other people',25)
line([(330,331),(330,355)])
line([(1590,331),(1590,355)])

box((100,355,560,555))
text(330,412,'Your Muse',36,bold=True)
text(330,471,'Your profile. Your decisions.',25)

box((735,330,1185,585))
text(960,381,'Mupid backend',36,bold=True)
text(960,443,'Find eligible profiles',26)
text(960,488,'Coordinate conversations',26)
text(960,533,'Enforce approvals',26)

box((1360,355,1820,555))
text(1590,412,'Their agents',36,bold=True)
text(1590,471,'Their profiles. Their decisions.',25)

arrow([(560,455),(735,455)],both=True)
text(647,421,'MCP',21)
arrow([(1185,455),(1360,455)],both=True)
text(1272,421,'MCP',21)

line([(960,585),(960,635)])
line([(350,635),(1570,635)])
for x in [350,960,1570]:
    arrow([(x,635),(x,710)])

box((100,710,600,880))
text(350,757,'Database',30,bold=True)
text(350,807,'Profiles + conversations',25)
text(350,847,'SQLite',21)

box((710,710,1210,880))
text(960,757,'Meta-powered matchmaker',29,bold=True)
text(960,807,'Spots gaps. Suggests questions.',25)
text(960,847,'Hosted model · shared context only',21)

box((1320,710,1820,880))
text(1570,757,'Encrypted contacts',30,bold=True)
text(1570,807,'Held until both sides are ready',25)
text(1570,847,'Never included in model prompts',21)

text(960,948,'Both approve the channel + submit contacts. Then handles are released.',29,bold=True)
text(960,1012,'Demo: simulated participants · real backend + model calls',22)

im.save(OUT / 'mupid-architecture.png')
print(f'Saved {OUT / "mupid-architecture.png"} ({im.width} × {im.height})')
