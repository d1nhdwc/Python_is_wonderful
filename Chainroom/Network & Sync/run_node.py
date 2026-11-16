import sys
from network import create_app, join_network, sync_chain, sync_pending, recover_bootstrap

ports = {"A": 5001, "B": 5002, "C": 5000, "D": 5003, "E": 5004, "F": 5005}

if len(sys.argv) != 2 or sys.argv[1] not in ports:
    sys.exit()

node_name = sys.argv[1]
application = create_app(node_name=node_name, host=(node_name == "C"))

state = application.config["NODE_STATE"]

if node_name == "C":
    recover_bootstrap(state)
else:
    join_network(state, ports[node_name])
    sync_chain(state)
    sync_pending(state)

application.run(host="0.0.0.0", port=ports[node_name], debug=False)
