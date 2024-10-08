import React from 'react';
import { SelectIDNodeRed } from './components/SelectID';

function App(): React.JSX.Element {
    return (
        <SelectIDNodeRed
            language="en"
            open
            onclose={id => console.log(id)}
            port="8081"
        />
    );
}

export default App;
