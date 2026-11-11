import { useLayoutEffect, useRef, useState } from 'react';
import { DEMO_HEIGHT, DEMO_WIDTH } from '../data/copy';
export function useStageScale() {
    const outerRef = useRef(null);
    const rootRef = useRef(null);
    const [scale, setScale] = useState(1);
    const [rootSize, setRootSize] = useState({ width: DEMO_WIDTH, height: DEMO_HEIGHT });
    useLayoutEffect(() => {
        const outer = outerRef.current;
        if (!outer)
            return;
        const update = () => {
            setScale(Math.min(1, outer.getBoundingClientRect().width / DEMO_WIDTH));
            if (rootRef.current) {
                setRootSize({
                    width: rootRef.current.clientWidth,
                    height: rootRef.current.clientHeight,
                });
            }
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(outer);
        if (rootRef.current)
            observer.observe(rootRef.current);
        return () => observer.disconnect();
    }, []);
    return { outerRef, rootRef, scale, rootSize };
}
