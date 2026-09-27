import sys, math
# usage: thd.py dumpfile freq  -> THD (engine and ref columns), harmonics 2..10
f = float(sys.argv[2])
t=[];r=[];e=[]
for line in open(sys.argv[1]).read().split('\n')[1:]:
    if not line.strip(): continue
    a,b,c=map(float,line.split()); t.append(a); r.append(b); e.append(c)
def amps(x):
    n=len(x); m=sum(x)/n; out=[]
    for h in range(1,11):
        w=2*math.pi*f*h
        cs=sum((x[k]-m)*math.cos(w*t[k]) for k in range(n)); sn=sum((x[k]-m)*math.sin(w*t[k]) for k in range(n))
        out.append(2*math.hypot(cs,sn)/n)
    return out
for name,x in (('engine',e),('ngspice',r)):
    a=amps(x); thd=math.sqrt(sum(v*v for v in a[1:]))/a[0]
    print(f"{name}: fund {a[0]*1000:.1f} mVpk THD {thd*100:.1f}% h2 {20*math.log10(a[1]/a[0]):.1f} dB h3 {20*math.log10(a[2]/a[0]):.1f} dB")
