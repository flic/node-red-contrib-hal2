# node-red-contrib-hal2 [![npm version](https://badge.fury.io/js/node-red-contrib-hal2.svg)](https://badge.fury.io/js/node-red-contrib-hal2)
A set of nodes to help with basic home automation logic.

**Note:** Even more new examples added

## Install
```bash
cd ~/.node-red
npm install node-red-contrib-hal2
```

## What is it?
**node-red-contrib-hal2** is a set of Node-RED nodes useful for creating home automation flows. The basic component is the Thing node, a virtual representation of a (usually) physical IoT device. This can then be used to trigger events, route traffic based on rules and more.

![Example Items](https://user-images.githubusercontent.com/400673/168665494-db5c244e-6225-4ae0-beed-fab3131e1b0a.png)

1. Store a device state in a **Thing node**
2. Fire an event when the value changes using an **Event node**
3. One or more rules will compare the value and that of other Items in a **Gate node**
4. Output the value to another flow with a **Value node**
5. Send device commands to multiple Things using an **Action node**
6. Log changes using the **Log node**

![Example automation flows](https://user-images.githubusercontent.com/400673/168665539-3984681b-5059-4ed6-b350-683a431841d8.png)

Take a look at the example flows and Thing definitions in the https://github.com/flic/node-red-contrib-hal2/tree/main/examples folder for more information.

![Example logging](https://user-images.githubusercontent.com/400673/168665807-aa3aba8f-8b06-4292-bcad-7374e508f59a.png)

## History

**1.15**<br>
Info button in Thing node shows all the places it's used.<br>
New option in Action node to only send command if it differs from state.<br>

**1.14**<br>
Event node status text (last trigger event, delay/rate limit status)<br>
Event node option to reset *Delay* if trigger no longer true<br>
New config options for *Event handler*<br>

**1.13**<br>
Event node *Delay* and *Rate Limit*.<br>
Dynamic msg.thing.id in Gate node.<br>
New examples (Delay, Rate limit and Time Since Changed).<br>

**1.12**<br>
Ingress and egress functions can use *item* and *attribute* objects.<br>
It's now possible to base *Alive* on a *last seen* timestamp, great for zigbee2mqtt.<br>

**1.11**<br>
New options for Gate rules: Time Since Update and Time Since Change.<br>
It's now possible to use a function to create dynamic status text strings for Items.<br>
Value and Item node output includes last_update and last_change epoch date.<br>
New examples.

**1.10**<br>
Export and import Thingtypes using the Node-RED Library function.<br>
Minimum node version bumped to >=14, minimum Node-RED version bumped to >= 2.2.0. 

**1.9**<br>
It's now possible to configure multiple outputs on the Thing node and use a specific output per command.

**1.8**<br>
Value node can update Item values

**1.7**<br>
Command loopback for virtual Things

**1.6**<br>
Thing attributes & filter function added.<br>
Thing Cmnd topic parameter changed to a general topic parameter, some changes to Item topic filter and command topic.

**1.5**<br>
Item notes added

**1.4**<br>
Item filter applied to all node types

**1.3**<br>
Dynamically set thing.id at runtime

**1.2**<br>
Copy functions from other types

**1.1**<br>
Item filter on gate node

**1.0**<br>
Initial release
