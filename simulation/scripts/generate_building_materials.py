"""Original, neutral, seamless procedural surface swatches (not photos of Gangnae)."""
from pathlib import Path
import numpy as np
from PIL import Image
P=Path(__file__).resolve().parents[1]/'assets'/'building-materials';P.mkdir(exist_ok=True)
n=256;y,x=np.mgrid[0:n,0:n];rng=np.random.default_rng(2107)
noise=rng.normal(0,1.5,(n,n));low=2*np.sin(x*2*np.pi/n)*np.cos(y*4*np.pi/n)+1.5*np.sin((x+y)*6*np.pi/n)
def save(name,base,pattern):
 a=np.clip(np.array(base)[None,None,:]+(noise+low+pattern)[:,:,None],0,255).astype('uint8');Image.fromarray(a).save(P/(name+'.png'),optimize=True)
save('plaster',[218,213,202],0)
# Fine, low contrast masonry joints. 2 m tile, staggered bonds.
row=y//16; xx=(x+(row%2)*16)%32; mortar=(y%16<1)|(xx<1); save('brick',[190,175,157],np.where(mortar,9,-1)+((row%5)-2)*.7)
save('concrete',[211,213,207],np.where(y%128<2,-6,0)+np.where(x%128<2,-4,0))
save('metal',[187,198,200],np.cos(x*2*np.pi/16)*3+np.where(x%128<2,-5,0))
save('roof-metal',[107,125,132],np.cos(x*2*np.pi/16)*5)
save('roof-tile',[111,119,120],np.where(y%16<2,-7,0)+np.cos(x*2*np.pi/16)*3)
